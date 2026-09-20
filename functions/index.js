// Только объявления облачных функций. Вся логика — в lib/, по модулю на раздел.
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentDeleted,
} = require("firebase-functions/v2/firestore");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const {
  BOT_TOKEN,
  WEBHOOK_SECRET,
  GEMINI_API_KEY,
  TOPICS_CHAT_ID,
  REMINDER_TIMEZONE,
} = require("./lib/config");
const { checkTelegramInitData } = require("./lib/auth");
const {
  isoDateInTimeZone,
  isoDateOfInstant,
  addDaysToDateStr,
  formatDueDate,
} = require("./lib/dates");
const { isPaymentDueOn, isPaidFor, periodOf, monthlyCost } = require("./lib/payments");
const { sendTelegramMessage, callTelegramApi, buildTopicLink, answerCallback } = require("./lib/telegram");
const { getUserName } = require("./lib/users");
const {
  sortByDueDate,
  morningSummaryText,
  eveningSummaryText,
  pendingTaskCardText,
} = require("./lib/summaries");
const {
  assignmentMessage,
  taskActionsKeyboard,
  CAPTURE_ACTIONS,
  handleTaskCallback,
} = require("./lib/tasks");
const {
  shoppingAssignmentMessage,
  shoppingActionsKeyboard,
  SHOPPING_ACTIONS,
  handleShoppingCallback,
} = require("./lib/shopping");
const { notifyEventParticipants, EVENT_ACTIONS, handleEventCallback } = require("./lib/events");
const { PLAN_TYPES, PLAN_TYPE_EMOJI, PLAN_TYPE_TITLE, isClosedStatus } = require("./lib/plans");
const { BIND_RE, handleBindCommand, handleTopicCapture } = require("./lib/topics");
const { START_RE, CONFIRM_RE, handleStartCommand, handleConfirmCommand } = require("./lib/bot");
const {
  MEAL_RE,
  MEAL_OK_RE,
  MEAL_ACTIONS,
  handleMealCommand,
  handleMealOkCommand,
  handleMealCallback,
} = require("./lib/meals");
const { fetchRatesFromCbu, saveRatesForDate, getRatesForDate } = require("./lib/rates");
const { ASK_RE, handleAskCommand, handlePrivateText } = require("./lib/ai-bot");
const { askModel } = require("./lib/gemini");
const {
  SYSTEM_INSTRUCTION,
  buildContext,
  formatContext,
  getRecentDialogue,
  saveConversation,
  getConversationHistory,
  clearConversationHistory,
} = require("./lib/ai");

exports.verifyInitData = onRequest(
  { secrets: [BOT_TOKEN], cors: true },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
      }

      const { initData } = req.body || {};
      if (!initData) {
        res.status(400).json({ error: "initData is required" });
        return;
      }

      const user = checkTelegramInitData(initData, BOT_TOKEN.value());
      if (!user) {
        res.status(401).json({ error: "Invalid or expired initData" });
        return;
      }

      const uid = String(user.id);

      const whitelistDoc = await getFirestore().collection("users").doc(uid).get();
      if (!whitelistDoc.exists) {
        res.status(403).json({ error: "Not a family member" });
        return;
      }

      const customToken = await getAuth().createCustomToken(uid);
      res.status(200).json({ token: customToken });
    } catch (err) {
      console.error("verifyInitData failed:", err);
      res.status(500).json({ error: "Internal error", detail: err.message });
    }
  }
);

exports.sendMorningTaskSummary = onSchedule(
  { schedule: "15 8 * * *", timeZone: REMINDER_TIMEZONE, secrets: [BOT_TOKEN] },
  async () => {
    const db = getFirestore();
    const today = isoDateInTimeZone(REMINDER_TIMEZONE, 0);

    const [tasksSnap, shoppingSnap, usersSnap] = await Promise.all([
      db.collection("tasks").where("status", "==", "open").get(),
      db.collection("shopping_items").where("status", "==", "active").get(),
      db.collection("users").get(),
    ]);
    const openTasks = tasksSnap.docs.map((d) => d.data());
    const activeShopping = shoppingSnap.docs.map((d) => d.data());

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const mine = openTasks.filter(
        (task) => task.assigneeUid === uid && task.dueDate && task.dueDate <= today
      );
      const myShopping = activeShopping.filter((item) => item.assigneeUid === uid);

      // Лично на человека ничего не назначено — не пишем вовсе, даже если общий список
      // покупок не пуст: сводка личная, а не «что вообще есть в семье».
      if (mine.length === 0 && myShopping.length === 0) continue;

      const overdue = mine.filter((task) => task.dueDate < today).sort(sortByDueDate);
      const dueToday = mine.filter((task) => task.dueDate === today).sort(sortByDueDate);

      await sendTelegramMessage(
        BOT_TOKEN.value(),
        uid,
        morningSummaryText(overdue, dueToday, activeShopping.length, myShopping.length)
      );
    }
  }
);

exports.onShoppingCreated = onDocumentCreated(
  { document: "shopping_items/{itemId}", secrets: [BOT_TOKEN] },
  async (event) => {
    const item = event.data.data();
    if (!item.assigneeUid) return;
    if (item.assigneeUid === item.authorUid) return; // назначил покупку сам себе

    const assignerName = await getUserName(item.authorUid);
    await sendTelegramMessage(
      BOT_TOKEN.value(),
      item.assigneeUid,
      shoppingAssignmentMessage(item, assignerName, false),
      { reply_markup: shoppingActionsKeyboard(event.params.itemId) }
    );
  }
);

exports.onShoppingUpdated = onDocumentUpdated(
  { document: "shopping_items/{itemId}", secrets: [BOT_TOKEN] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (!after.assigneeUid) return;
    if (before.assigneeUid === after.assigneeUid) return; // исполнитель не менялся

    const actorUid = after.lastEditedBy || after.authorUid;
    if (after.assigneeUid === actorUid) return; // переназначил на себя

    const assignerName = await getUserName(actorUid);
    await sendTelegramMessage(
      BOT_TOKEN.value(),
      after.assigneeUid,
      shoppingAssignmentMessage(after, assignerName, true),
      { reply_markup: shoppingActionsKeyboard(event.params.itemId) }
    );
  }
);

exports.onEventCreated = onDocumentCreated(
  { document: "events/{eventId}", secrets: [BOT_TOKEN] },
  async (event) => {
    const eventItem = event.data.data();
    const participants = eventItem.participantUids || [];
    if (participants.length === 0) return; // «касается всех» — отдельно никому не пишем

    const actorUid = eventItem.lastEditedBy || eventItem.authorUid;
    const recipients = participants.filter((uid) => uid !== actorUid);
    await notifyEventParticipants(BOT_TOKEN.value(), eventItem, recipients, actorUid, true);
  }
);

exports.onEventUpdated = onDocumentUpdated(
  { document: "events/{eventId}", secrets: [BOT_TOKEN] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const wasParticipants = before.participantUids || [];
    const nowParticipants = after.participantUids || [];

    // Пишем только тем, кого добавили именно этой правкой: иначе каждое изменение места
    // или времени рассылало бы «вас добавили» всем по кругу.
    const actorUid = after.lastEditedBy || after.authorUid;
    const added = nowParticipants.filter(
      (uid) => !wasParticipants.includes(uid) && uid !== actorUid
    );
    await notifyEventParticipants(BOT_TOKEN.value(), after, added, actorUid, false);
  }
);

exports.sendEveningTaskReview = onSchedule(
  { schedule: "0 20 * * *", timeZone: REMINDER_TIMEZONE, secrets: [BOT_TOKEN] },
  async () => {
    const db = getFirestore();
    const today = isoDateInTimeZone(REMINDER_TIMEZONE, 0);

    // Сутки назад с запасом, потом отбор по дню в нашем поясе: так граница «сегодня»
    // не зависит от того, как пояс смещён относительно UTC.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [openSnap, closedSnap, usersSnap] = await Promise.all([
      db.collection("tasks").where("status", "==", "open").get(),
      db.collection("tasks").where("closedAt", ">=", since).get(),
      db.collection("users").get(),
    ]);

    const openTasks = openSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const closedTasks = closedSnap.docs
      .map((d) => d.data())
      .filter((task) => isoDateOfInstant(task.closedAt.toDate(), REMINDER_TIMEZONE) === today);

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const pending = openTasks
        .filter((task) => task.assigneeUid === uid && task.dueDate && task.dueDate <= today)
        .sort(sortByDueDate);
      const closed = closedTasks.filter((task) => task.assigneeUid === uid);

      // Ни сделанного, ни несделанного — человеку сегодня нечего сказать
      if (pending.length === 0 && closed.length === 0) continue;

      await sendTelegramMessage(
        BOT_TOKEN.value(),
        uid,
        eveningSummaryText(closed, pending.length)
      );

      for (const task of pending) {
        await sendTelegramMessage(BOT_TOKEN.value(), uid, pendingTaskCardText(task), {
          reply_markup: taskActionsKeyboard(task.id),
        });
      }
    }
  }
);

exports.onTaskCreated = onDocumentCreated(
  { document: "tasks/{taskId}", secrets: [BOT_TOKEN] },
  async (event) => {
    const task = event.data.data();
    if (!task.assigneeUid) return;
    if (task.assigneeUid === task.authorUid) return; // назначил задачу сам себе

    const assignerName = await getUserName(task.authorUid);
    await sendTelegramMessage(
      BOT_TOKEN.value(),
      task.assigneeUid,
      assignmentMessage(task, assignerName, false),
      { reply_markup: taskActionsKeyboard(event.params.taskId) }
    );
  }
);

exports.onTaskUpdated = onDocumentUpdated(
  { document: "tasks/{taskId}", secrets: [BOT_TOKEN] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (!after.assigneeUid) return;
    if (before.assigneeUid === after.assigneeUid) return; // исполнитель не менялся

    // Кто именно правил — из документа: Firestore-триггер этого не знает, поэтому
    // mini-app пишет `lastEditedBy` при каждом сохранении задачи.
    const actorUid = after.lastEditedBy || after.authorUid;
    if (after.assigneeUid === actorUid) return; // переназначил задачу на себя

    const assignerName = await getUserName(actorUid);
    await sendTelegramMessage(
      BOT_TOKEN.value(),
      after.assigneeUid,
      assignmentMessage(after, assignerName, true),
      { reply_markup: taskActionsKeyboard(event.params.taskId) }
    );
  }
);

// Кнопка «🔔 Напомнить» в карточке задачи: автор просит исполнителя вернуться к задаче.
// Отправку делает сервер — токен бота не должен попадать в браузер.
exports.remindAssignee = onCall({ secrets: [BOT_TOKEN] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Нужна авторизация");
  }
  const taskId = request.data && request.data.taskId;
  if (!taskId) {
    throw new HttpsError("invalid-argument", "Не передан taskId");
  }

  const taskRef = getFirestore().collection("tasks").doc(String(taskId));
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    throw new HttpsError("not-found", "Задача не найдена");
  }

  const task = taskSnap.data();
  if (task.authorUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Напомнить может только автор задачи");
  }
  if (!task.assigneeUid) {
    throw new HttpsError("failed-precondition", "У задачи нет исполнителя");
  }
  if (task.assigneeUid === request.auth.uid) {
    throw new HttpsError("failed-precondition", "Нельзя напомнить самому себе");
  }

  const authorName = await getUserName(request.auth.uid);
  const lines = [`🔔 Напоминание от ${authorName}`, "", `«${task.text}»`];
  const due = formatDueDate(task.dueDate);
  if (due) lines.push(`Срок: ${due}`);

  // Без этой проверки отказ Telegram (например, исполнитель не нажимал /start
  // и бот не может ему написать) вернулся бы в интерфейс как успех.
  const delivered = await sendTelegramMessage(
    BOT_TOKEN.value(),
    task.assigneeUid,
    lines.join("\n"),
    { reply_markup: taskActionsKeyboard(String(taskId)) }
  );
  if (!delivered) {
    throw new HttpsError("unavailable", "Telegram не принял сообщение — возможно, исполнитель ещё не писал боту");
  }

  return { ok: true };
});

const EVENT_REMINDER_INTERVAL_MS = 30 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

exports.sendEventReminders = onSchedule(
  { schedule: "every 30 minutes", secrets: [BOT_TOKEN] },
  async () => {
    const db = getFirestore();
    const now = Date.now();

    const [eventsSnap, usersSnap] = await Promise.all([
      db.collection("events").get(),
      db.collection("users").get(),
    ]);
    const chatIds = usersSnap.docs.map((d) => d.id);

    for (const eventDoc of eventsSnap.docs) {
      const eventItem = eventDoc.data();
      if (!eventItem.startAt) continue;

      const diffMs = eventItem.startAt.toMillis() - now;
      const updates = {};
      let messageText = null;

      const in2Hours = diffMs <= TWO_HOURS_MS && diffMs > TWO_HOURS_MS - EVENT_REMINDER_INTERVAL_MS;
      const in1Day = diffMs <= ONE_DAY_MS && diffMs > ONE_DAY_MS - EVENT_REMINDER_INTERVAL_MS;

      if (in1Day && !eventItem.reminded1Day) {
        messageText = `Напоминание: завтра "${eventItem.title}"` +
          (eventItem.startTime ? ` в ${eventItem.startTime}` : "");
        updates.reminded1Day = true;
      } else if (in2Hours && !eventItem.reminded2Hours) {
        messageText = `Напоминание: через 2 часа "${eventItem.title}"` +
          (eventItem.startTime ? ` в ${eventItem.startTime}` : "");
        updates.reminded2Hours = true;
      }

      if (messageText) {
        // Кого касается событие. Пусто (в том числе у событий, созданных до появления
        // участников) — значит всех, как было раньше.
        const recipients =
          eventItem.participantUids && eventItem.participantUids.length > 0
            ? eventItem.participantUids
            : chatIds;

        await Promise.all(
          recipients.map((chatId) => sendTelegramMessage(BOT_TOKEN.value(), chatId, messageText))
        );
        await eventDoc.ref.update(updates);
      }
    }
  }
);

const RECURRING_REMINDER_DAYS_BEFORE = 3;
// Те же четыре, что и в приложении. Для платежа в снятой с выбора валюте подпись
// сведётся к её коду — так старые записи остаются читаемыми.
const CURRENCY_SYMBOLS = { UZS: "сум", USD: "$", EUR: "€", RUB: "₽" };

// Кому писать о платеже. Личный знает только автор; у общего с назначенным плательщиком
// напоминание нужно тому, кто платит, — второму оно ничего не даёт и лишь приучает
// пролистывать сообщения бота. Платёж без плательщика общий, как было всегда.
function paymentRecipients(payment, chatIds) {
  const known = (uid) => chatIds.includes(String(uid));

  if (payment.visibility === "private") {
    return known(payment.authorUid) ? [String(payment.authorUid)] : [];
  }
  if (payment.payerUid && known(payment.payerUid)) {
    return [String(payment.payerUid)];
  }
  // Плательщик указан, но такого участника больше нет — молчать хуже, чем написать
  // обоим: платёж-то остался.
  return chatIds;
}

exports.sendRecurringPaymentReminders = onSchedule(
  { schedule: "0 9 * * *", timeZone: REMINDER_TIMEZONE, secrets: [BOT_TOKEN] },
  async () => {
    const db = getFirestore();
    // Отметка об отправленном напоминании — сама дата платежа, а не месяц. Через месяц
    // ключ годился, пока платежи были только ежемесячные; для еженедельного он схлопнул
    // бы четыре платежа в один. Дата работает для любой периодичности.
    const today = isoDateInTimeZone(REMINDER_TIMEZONE, 0);
    // Заглядываем на три дня вперёд — так переход через границу месяца получается сам
    // собой: 29 января мы видим, что 1 февраля платёж, и предупреждаем.
    const soon = addDaysToDateStr(today, RECURRING_REMINDER_DAYS_BEFORE);

    const [paymentsSnap, usersSnap] = await Promise.all([
      db.collection("recurring_payments").where("status", "==", "active").get(),
      db.collection("users").get(),
    ]);
    const chatIds = usersSnap.docs.map((d) => d.id);

    for (const paymentDoc of paymentsSnap.docs) {
      const payment = paymentDoc.data();
      const symbol = CURRENCY_SYMBOLS[payment.currency] || payment.currency || "";
      const amount = `${payment.amount.toLocaleString("ru-RU")} ${symbol}`;
      const updates = {};
      let messageText = null;

      if (
        isPaymentDueOn(payment, today) &&
        payment.remindedDueDate !== today &&
        // Отметили оплату — напоминать не о чем. Ровно ради этого отметка и нужна.
        !isPaidFor(payment, today)
      ) {
        messageText = `Сегодня платёж «${payment.title}» — ${amount}`;
        updates.remindedDueDate = today;
      } else if (
        // Еженедельные не предупреждаем заранее: платёж через три дня и платёж сегодня
        // слились бы в два сообщения на каждую неделю, и читать перестали бы оба.
        periodOf(payment) !== "weekly" &&
        isPaymentDueOn(payment, soon) &&
        payment.remindedWarnDate !== soon &&
        !isPaidFor(payment, soon)
      ) {
        messageText = `Через ${RECURRING_REMINDER_DAYS_BEFORE} дня платёж «${payment.title}» — ${amount}`;
        updates.remindedWarnDate = soon;
      }

      if (messageText) {
        await Promise.all(
          paymentRecipients(payment, chatIds).map((chatId) =>
            sendTelegramMessage(BOT_TOKEN.value(), chatId, messageText)
          )
        );
        await paymentDoc.ref.update(updates);
      }
    }
  }
);

// Курс ЦБ на сегодня публикуется накануне вечером, так что утренний запуск уже застаёт
// свежий. Раз в сутки достаточно: официальный курс внутри дня не меняется.
exports.fetchExchangeRates = onSchedule(
  { schedule: "30 7 * * *", timeZone: REMINDER_TIMEZONE },
  async () => {
    const today = isoDateInTimeZone(REMINDER_TIMEZONE, 0);
    try {
      const rates = await fetchRatesFromCbu();
      await saveRatesForDate(today, rates);
      console.log(`[rates] ${today}:`, rates);
    } catch (err) {
      // Молча: вчерашний курс остаётся в силе, а трата запишется по последнему
      // известному. Ронять функцию из-за недоступного сайта ЦБ незачем.
      console.error("[rates] не удалось обновить:", err.message);
    }
  }
);

// Курс для приложения: оно фиксирует его в записи о трате, поэтому просит не «последний
// известный», а курс на конкретный день. Если документа на сегодня ещё нет — плановая
// функция не отработала, ЦБ лежал, сегодня выходной — тянем сами и сохраняем; если и ЦБ
// недоступен, отдаём последний известный вместе с его датой, чтобы приложение показало,
// на какое число посчитано.
exports.getExchangeRates = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Нужна авторизация");

  const today = isoDateInTimeZone(REMINDER_TIMEZONE, 0);

  const todaySnap = await getFirestore().collection("exchange_rates").doc(today).get();
  if (todaySnap.exists) return { date: today, rates: todaySnap.data().rates };

  try {
    const rates = await fetchRatesFromCbu();
    await saveRatesForDate(today, rates);
    return { date: today, rates };
  } catch (err) {
    console.error("[rates] запрос по требованию не удался:", err.message);
  }

  const fallback = await getRatesForDate(today, addDaysToDateStr);
  if (!fallback) throw new HttpsError("unavailable", "Курс пока недоступен");
  return fallback;
});

exports.onPlanCreated = onDocumentCreated(
  { document: "plans/{planId}", secrets: [BOT_TOKEN] },
  async (event) => {
    const plan = event.data.data();
    if (!PLAN_TYPES.includes(plan.type)) return;
    // Запись, родившаяся из диалога в теме «Приёмы пищи», своей темы обсуждения не
    // получает: обсуждение уже прошло, вторая тема про тот же ужин — мусор.
    if (plan.createdFrom === "meal_session") return;

    const emoji = PLAN_TYPE_EMOJI[plan.type] || "";
    const topicResult = await callTelegramApi(BOT_TOKEN.value(), "createForumTopic", {
      chat_id: TOPICS_CHAT_ID,
      name: `${emoji} ${plan.title}`.slice(0, 128),
    });
    if (!topicResult.ok) return;

    const threadId = topicResult.result.message_thread_id;
    const link = buildTopicLink(TOPICS_CHAT_ID, threadId);

    await callTelegramApi(BOT_TOKEN.value(), "sendMessage", {
      chat_id: TOPICS_CHAT_ID,
      message_thread_id: threadId,
      text: `${PLAN_TYPE_TITLE[plan.type]}: ${plan.title}\n\nОбсуждайте здесь.`,
    });

    await event.data.ref.update({
      telegramChatId: TOPICS_CHAT_ID,
      telegramMessageThreadId: threadId,
      telegramTopicLink: link,
    });
  }
);

exports.onPlanUpdated = onDocumentUpdated(
  { document: "plans/{planId}", secrets: [BOT_TOKEN] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (!PLAN_TYPES.includes(after.type)) return;
    if (!after.telegramMessageThreadId) return; // тема ещё не создана — нечего менять

    if (before.title !== after.title) {
      const emoji = PLAN_TYPE_EMOJI[after.type] || "";
      await callTelegramApi(BOT_TOKEN.value(), "editForumTopic", {
        chat_id: after.telegramChatId,
        message_thread_id: after.telegramMessageThreadId,
        name: `${emoji} ${after.title}`.slice(0, 128),
      });
    }

    const wasClosed = isClosedStatus(before.type, before.status);
    const isClosed = isClosedStatus(after.type, after.status);
    if (!wasClosed && isClosed) {
      await callTelegramApi(BOT_TOKEN.value(), "closeForumTopic", {
        chat_id: after.telegramChatId,
        message_thread_id: after.telegramMessageThreadId,
      });
    } else if (wasClosed && !isClosed) {
      await callTelegramApi(BOT_TOKEN.value(), "reopenForumTopic", {
        chat_id: after.telegramChatId,
        message_thread_id: after.telegramMessageThreadId,
      });
    }
  }
);

exports.onPlanDeleted = onDocumentDeleted(
  { document: "plans/{planId}", secrets: [BOT_TOKEN] },
  async (event) => {
    const plan = event.data.data();
    if (!plan.telegramMessageThreadId) return;
    await callTelegramApi(BOT_TOKEN.value(), "deleteForumTopic", {
      chat_id: plan.telegramChatId,
      message_thread_id: plan.telegramMessageThreadId,
    });
  }
);

exports.telegramWebhook = onRequest(
  { secrets: [BOT_TOKEN, WEBHOOK_SECRET, GEMINI_API_KEY] },
  async (req, res) => {
    if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET.value()) {
      res.status(401).send("Unauthorized");
      return;
    }

    const message = req.body && req.body.message;
    const callbackQuery = req.body && req.body.callback_query;

    try {
      if (callbackQuery) {
        const action = (callbackQuery.data || "").split(":")[0];
        if (action === "noop") {
          // шапка календаря и пустые клетки: Telegram не умеет неактивные кнопки, но
          // ответить на нажатие обязан кто-то, иначе у человека крутятся часики
          await answerCallback(BOT_TOKEN.value(), callbackQuery.id, "");
        } else if (SHOPPING_ACTIONS.has(action)) {
          await handleShoppingCallback(BOT_TOKEN.value(), callbackQuery);
        } else if (EVENT_ACTIONS.has(action)) {
          await handleEventCallback(BOT_TOKEN.value(), callbackQuery);
        } else if (MEAL_ACTIONS.has(action)) {
          await handleMealCallback(BOT_TOKEN.value(), callbackQuery);
        } else {
          await handleTaskCallback(BOT_TOKEN.value(), callbackQuery);
        }
      } else if (message && message.text && message.chat.type === "private" && START_RE.test(message.text)) {
        await handleStartCommand(BOT_TOKEN.value(), message);
      } else if (message && message.text && CONFIRM_RE.test(message.text)) {
        await handleConfirmCommand(BOT_TOKEN.value(), message);
      } else if (message && message.text && BIND_RE.test(message.text)) {
        await handleBindCommand(BOT_TOKEN.value(), message);
      } else if (message && message.text && ASK_RE.test(message.text)) {
        await handleAskCommand(BOT_TOKEN.value(), GEMINI_API_KEY.value(), message);
      } else if (message && message.text && MEAL_RE.test(message.text)) {
        await handleMealCommand(BOT_TOKEN.value(), message);
      } else if (message && message.text && MEAL_OK_RE.test(message.text)) {
        await handleMealOkCommand(BOT_TOKEN.value(), message);
      } else if (
        message &&
        message.text &&
        !message.text.startsWith("/") &&
        !message.from.is_bot &&
        message.message_thread_id &&
        (message.chat.type === "supergroup" || message.chat.type === "group")
      ) {
        await handleTopicCapture(BOT_TOKEN.value(), message);
      } else if (
        message &&
        message.text &&
        !message.text.startsWith("/") &&
        !message.from.is_bot &&
        message.chat.type === "private"
      ) {
        await handlePrivateText(BOT_TOKEN.value(), GEMINI_API_KEY.value(), message);
      }
    } catch (err) {
      console.error("telegramWebhook failed:", err);
    }

    res.status(200).send("OK");
  }
);

// ---- Бюджетный алерт Google Cloud/Firebase → Telegram (вместо почты) ----
exports.onBudgetAlert = onMessagePublished(
  { topic: "budget-alerts", secrets: [BOT_TOKEN] },
  async (event) => {
    const data = event.data.message.json;
    if (!data || data.alertThresholdExceeded === undefined || data.alertThresholdExceeded === null) {
      // Pub/Sub-уведомление о бюджете шлётся при каждом обновлении трат, не только при
      // пересечении порога — это поле присутствует только когда порог реально превышен.
      return;
    }

    const currency = data.currencyCode || "USD";
    const costAmount = Number(data.costAmount || 0);
    const budgetAmount = Number(data.budgetAmount || 0);
    const pct = Math.round((data.alertThresholdExceeded || 0) * 100);

    const text =
      `⚠️ Бюджет Google Cloud/Firebase: превышен порог ${pct}%\n` +
      `Потрачено ${costAmount.toFixed(2)} ${currency} из ${budgetAmount.toFixed(2)} ${currency}`;

    const db = getFirestore();
    const usersSnap = await db.collection("users").get();
    const chatIds = usersSnap.docs.map((d) => d.id);

    await Promise.all(chatIds.map((chatId) => sendTelegramMessage(BOT_TOKEN.value(), chatId, text)));
  }
);

// ---- ИИ-помощник для мини-приложения ----
// Те же вопросы, что и /ask в боте, но из интерфейса планировщика. История у каждого
// своя: и запись, и чтение идут по uid вызывающего, подделать чужой нельзя.

const MAX_QUESTION_LENGTH = 1000;

exports.askAi = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Нужна авторизация");

  const question = String((request.data && request.data.question) || "").trim();
  if (!question) throw new HttpsError("invalid-argument", "Вопрос пустой");
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new HttpsError("invalid-argument", "Вопрос слишком длинный");
  }

  try {
    const [context, dialogue] = await Promise.all([buildContext(uid), getRecentDialogue(uid)]);
    const answer = await askModel(
      GEMINI_API_KEY.value(),
      SYSTEM_INSTRUCTION,
      `${formatContext(context)}\n\nВопрос: ${question}`,
      dialogue
    );
    const id = await saveConversation(uid, question, answer);
    return { answer, id };
  } catch (err) {
    console.error("askAi failed:", err);
    throw new HttpsError("internal", "Модель не ответила, попробуйте ещё раз");
  }
});

exports.getAiHistory = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Нужна авторизация");

  const limit = Math.min(Math.max(Number(request.data && request.data.limit) || 10, 1), 50);
  return { history: await getConversationHistory(uid, limit) };
});

exports.clearAiHistory = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Нужна авторизация");

  return { deleted: await clearConversationHistory(uid) };
});

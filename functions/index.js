const crypto = require("crypto");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentDeleted,
} = require("firebase-functions/v2/firestore");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();

const BOT_TOKEN = defineSecret("BOT_TOKEN");
const WEBHOOK_SECRET = defineSecret("WEBHOOK_SECRET");
// Приватная супергруппа с включённым режимом Topics — обсуждения поездок/досуга/приёмов пищи.
// Не секрет (просто числовой ID чата), поэтому хранится как обычная константа.
const TOPICS_CHAT_ID = -1004324845791;
const WEBAPP_URL = "https://pus847uz-ui.github.io/family-planner/";
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

function checkTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) {
    return null;
  }
  params.delete("hash");

  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (computedHash !== hash) {
    return null;
  }

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > MAX_INIT_DATA_AGE_SECONDS) {
    return null;
  }

  const userJson = params.get("user");
  if (!userJson) {
    return null;
  }
  return JSON.parse(userJson);
}

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

// Ташкент, а не Карачи: смещение то же (UTC+5), но пояс выбран осознанно, а не
// случайно — время в напоминаниях должно совпадать с тем, по которому живёт семья.
const REMINDER_TIMEZONE = "Asia/Tashkent";

function isoDateInTimeZone(timeZone, offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

// Какой это был день по нашему поясу для произвольного момента времени. Нужно, чтобы
// отобрать закрытое «сегодня», не вычисляя вручную смещение пояса от UTC.
function isoDateOfInstant(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(instant);
}

async function sendTelegramMessage(botToken, chatId, text, extra = {}) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
  if (!response.ok) {
    console.error("sendTelegramMessage failed:", await response.text());
  }
  return response.ok;
}

// ---- Утренняя сводка «что сегодня» ----
// Личная и адресная: каждому только то, что назначено лично на него. Если назначенного
// на сегодня ничего нет — сообщения не будет вовсе (молчание по умолчанию).

function sortByDueDate(a, b) {
  return (a.dueDate || "").localeCompare(b.dueDate || "");
}

function pluralRu(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function morningSummaryText(overdue, dueToday, shoppingTotal, shoppingMine) {
  const lines = ["☀️ На сегодня:"];
  if (overdue.length > 0) {
    lines.push("", "🔴 Просрочено:");
    overdue.forEach((task) => lines.push(`• ${task.text} (${formatDueDate(task.dueDate)})`));
  }
  if (dueToday.length > 0) {
    lines.push("", "📋 Сегодня:");
    dueToday.forEach((task) => lines.push(`• ${task.text}`));
  }
  if (shoppingTotal > 0) {
    const word = pluralRu(shoppingTotal, "позиция", "позиции", "позиций");
    lines.push(
      "",
      shoppingMine > 0
        ? `🛒 В списке покупок ${shoppingTotal} ${word}, из них на вас ${shoppingMine}`
        : `🛒 В списке покупок ${shoppingTotal} ${word}`
    );
  }
  return lines.join("\n");
}

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

// ---- Уведомления о назначении покупки ----
// Та же схема, что у задач: триггер, а не код мини-аппа, чтобы одинаково срабатывало и при
// вводе из приложения, и при вводе из темы. Кнопки переноса здесь нет — у покупки нет срока.

function shoppingActionsKeyboard(itemId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Купил", callback_data: `sdone:${itemId}` },
        { text: "🚫 Не нужно", callback_data: `sdrop:${itemId}` },
      ],
    ],
  };
}

function shoppingAssignmentMessage(item, assignerName, isReassignment) {
  const lines = [
    isReassignment ? "🛒 На вас переназначена покупка" : "🛒 На вас назначена покупка",
    "",
    `«${item.text}»`,
  ];
  if (item.quantity) lines.push(`Количество: ${item.quantity}`);
  lines.push(`Назначил: ${assignerName}`);
  return lines.join("\n");
}

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

// ---- Уведомления об участии в событии ----
// В отличие от задач и покупок, участников может быть несколько, поэтому уведомляем всех,
// кого добавили, кроме того, кто сам это сделал.

function eventWhenText(eventItem) {
  const date = formatDueDate(eventItem.startDate);
  const time = eventItem.startTime || "весь день";
  return `${date} ${time}`;
}

function eventNotificationMessage(eventItem, actorName, isNew) {
  const lines = [
    isNew ? "📅 Новое событие" : "📅 Вас добавили в событие",
    "",
    `«${eventItem.title}»`,
    eventWhenText(eventItem),
  ];
  if (eventItem.place) lines.push(`Место: ${eventItem.place}`);
  lines.push(`Добавил: ${actorName}`);
  return lines.join("\n");
}

function eventKeyboard(eventItem) {
  // Ссылка на карту — обычной url-кнопкой; никаких действий над событием «нажатием» нет,
  // завершать или переносить его как задачу бессмысленно.
  if (!eventItem.locationUrl) return undefined;
  return { inline_keyboard: [[{ text: "📍 Место на карте", url: eventItem.locationUrl }]] };
}

async function notifyEventParticipants(botToken, eventItem, recipients, actorUid, isNew) {
  if (recipients.length === 0) return;
  const actorName = await getUserName(actorUid);
  const text = eventNotificationMessage(eventItem, actorName, isNew);
  const keyboard = eventKeyboard(eventItem);

  await Promise.all(
    recipients.map((uid) =>
      sendTelegramMessage(botToken, uid, text, keyboard ? { reply_markup: keyboard } : {})
    )
  );
}

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

// ---- Вечерний разбор «сделано или нет» ----
// Сводка за день плюс отдельная карточка на каждую незакрытую задачу: по ней сразу можно
// отчитаться, перенести срок или закрыть как ненужную, не открывая приложение.

function eveningSummaryText(closedToday, pendingCount) {
  const lines = ["🌙 Итоги дня"];

  if (closedToday.length > 0) {
    lines.push("", "Закрыто сегодня:");
    closedToday.forEach((task) =>
      lines.push(`${task.status === "done" ? "✅" : "🚫"} ${task.text}`)
    );
  }

  if (pendingCount === 0) {
    lines.push("", "На сегодня всё закрыто 👍");
  } else {
    lines.push("", `Осталось незакрытым: ${pendingCount}`);
  }

  return lines.join("\n");
}

function pendingTaskCardText(task) {
  const lines = [`❓ Не закрыто: «${task.text}»`];
  const due = formatDueDate(task.dueDate);
  if (due) lines.push(`Срок: ${due}`);
  return lines.join("\n");
}

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

// ---- Уведомления о назначении задачи ----
// Id документа в `users` — это и есть telegram id участника, поэтому `assigneeUid`
// можно передавать в Bot API как `chat_id` напрямую, ничего дополнительно не храня.

async function getUserName(uid) {
  if (!uid) return "—";
  const snap = await getFirestore().collection("users").doc(String(uid)).get();
  return (snap.exists && snap.data().name) || String(uid);
}

function formatDueDate(dueDate) {
  if (!dueDate) return null;
  const [year, month, day] = dueDate.split("-");
  return `${day}.${month}.${year}`;
}

function assignmentMessage(task, assignerName, isReassignment) {
  const lines = [
    isReassignment ? "📋 На вас переназначена задача" : "📋 На вас назначена новая задача",
    "",
    `«${task.text}»`,
  ];
  const due = formatDueDate(task.dueDate);
  if (due) lines.push(`Срок: ${due}`);
  lines.push(`Назначил: ${assignerName}`);
  return lines.join("\n");
}

// Кнопки под сообщением о задаче. callback_data — "действие:taskId", 64 байта лимита
// Telegram хватает с запасом: id документа Firestore — 20 символов.
function taskActionsKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Сделал", callback_data: `tdone:${taskId}` },
        { text: "⏰ Перенести", callback_data: `tpost:${taskId}` },
      ],
      [{ text: "🚫 Не нужно", callback_data: `tdrop:${taskId}` }],
    ],
  };
}

function taskPostponeKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: "Завтра", callback_data: `tp1:${taskId}` },
        { text: "+7 дней", callback_data: `tp7:${taskId}` },
        { text: "← Назад", callback_data: `tback:${taskId}` },
      ],
    ],
  };
}

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
const CURRENCY_SYMBOLS = {
  USD: "$", EUR: "€", UZS: "сум", RUB: "₽", KZT: "₸", PKR: "₨", GBP: "£", UAH: "₴",
};

function dayAndMonthKeyInTimeZone(timeZone) {
  const iso = isoDateInTimeZone(timeZone, 0); // "YYYY-MM-DD"
  const [year, month, day] = iso.split("-").map(Number);
  return { day, monthKey: `${year}-${String(month).padStart(2, "0")}` };
}

exports.sendRecurringPaymentReminders = onSchedule(
  { schedule: "0 9 * * *", timeZone: REMINDER_TIMEZONE, secrets: [BOT_TOKEN] },
  async () => {
    const db = getFirestore();
    const { day, monthKey } = dayAndMonthKeyInTimeZone(REMINDER_TIMEZONE);

    const [paymentsSnap, usersSnap] = await Promise.all([
      db.collection("recurring_payments").where("status", "==", "active").get(),
      db.collection("users").get(),
    ]);
    const chatIds = usersSnap.docs.map((d) => d.id);

    for (const paymentDoc of paymentsSnap.docs) {
      const payment = paymentDoc.data();
      const symbol = CURRENCY_SYMBOLS[payment.currency] || payment.currency || "";
      const reminderDay = payment.dueDay - RECURRING_REMINDER_DAYS_BEFORE;
      const updates = {};
      let messageText = null;

      if (reminderDay >= 1 && day === reminderDay && payment.remindedMonth3Day !== monthKey) {
        messageText =
          `Через ${RECURRING_REMINDER_DAYS_BEFORE} дня платёж «${payment.title}» — ` +
          `${payment.amount.toLocaleString("ru-RU")} ${symbol}`;
        updates.remindedMonth3Day = monthKey;
      } else if (day === payment.dueDay && payment.remindedMonthDueDay !== monthKey) {
        messageText =
          `Сегодня платёж «${payment.title}» — ${payment.amount.toLocaleString("ru-RU")} ${symbol}`;
        updates.remindedMonthDueDay = monthKey;
      }

      if (messageText) {
        await Promise.all(
          chatIds.map((chatId) => sendTelegramMessage(BOT_TOKEN.value(), chatId, messageText))
        );
        await paymentDoc.ref.update(updates);
      }
    }
  }
);

// ---- Telegram-темы для обсуждения поездок/досуга/приёмов пищи ----
const PLAN_TYPES = ["trip", "leisure", "meal"];
const PLAN_TYPE_EMOJI = { trip: "✈️", leisure: "🎲", meal: "🍽" };
const PLAN_TYPE_TITLE = { trip: "Поездка", leisure: "Досуг", meal: "Приём пищи" };

async function callTelegramApi(botToken, method, params) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await response.json();
  if (!data.ok) {
    console.error(`Telegram API ${method} failed:`, data);
  }
  return data;
}

function buildTopicLink(chatId, threadId) {
  const internalId = String(chatId).replace(/^-100/, "");
  return `https://t.me/c/${internalId}/${threadId}`;
}

function isClosedStatus(type, status) {
  if (type === "trip") return status === "completed";
  if (type === "leisure") return status === "decided";
  if (type === "meal") return status === "decided";
  return false;
}

exports.onPlanCreated = onDocumentCreated(
  { document: "plans/{planId}", secrets: [BOT_TOKEN] },
  async (event) => {
    const plan = event.data.data();
    if (!PLAN_TYPES.includes(plan.type)) return;

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

// ---- Webhook бота: /start в личке + /confirm для закрепления бронирований в теме поездки ----
const BOOKING_TYPE_ICON = { flight: "✈️", hotel: "🏨", car: "🚗" };
// Telegram-клиент в группах иногда дописывает @имя_бота после команды
// (например, "/confirm@family_planner_xyz_bot flight") — обе команды разбираются через regex,
// чтобы не принять "@имя_бота..." за аргумент команды.
const START_RE = /^\/start(?:@[A-Za-z0-9_]+)?$/i;
const CONFIRM_RE = /^\/confirm(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/is;

function buildTelegramMessageLink(chatId, threadId, messageId) {
  const internalId = String(chatId).replace(/^-100/, "");
  return `https://t.me/c/${internalId}/${threadId}/${messageId}`;
}

async function handleStartCommand(botToken, message) {
  await callTelegramApi(botToken, "sendMessage", {
    chat_id: message.chat.id,
    text: "Привет! Открой планировщик кнопкой ниже:",
    reply_markup: {
      inline_keyboard: [[{ text: "Открыть Family Planner", web_app: { url: WEBAPP_URL } }]],
    },
  });
}

async function handleConfirmCommand(botToken, message) {
  const threadId = message.message_thread_id;

  if (!message.reply_to_message || !threadId) {
    await callTelegramApi(botToken, "sendMessage", {
      chat_id: message.chat.id,
      message_thread_id: threadId,
      reply_to_message_id: message.message_id,
      text: "Чтобы закрепить бронь: ответьте (reply) на сообщение с деталями командой /confirm тип (например, /confirm flight)",
    });
    return;
  }

  const match = message.text.match(CONFIRM_RE);
  const type = (match && match[1] && match[1].trim()) || "other";
  const db = getFirestore();
  const plansSnap = await db
    .collection("plans")
    .where("telegramChatId", "==", message.chat.id)
    .where("telegramMessageThreadId", "==", threadId)
    .limit(1)
    .get();

  if (plansSnap.empty) return;

  const planDoc = plansSnap.docs[0];
  const confirmedText = message.reply_to_message.text || message.reply_to_message.caption || "";

  await db.collection("plan_bookings").add({
    planId: planDoc.id,
    type,
    text: confirmedText,
    telegramMessageId: message.reply_to_message.message_id,
    telegramMessageLink: buildTelegramMessageLink(
      message.chat.id,
      threadId,
      message.reply_to_message.message_id
    ),
    confirmedByTelegramId: String(message.from.id),
    createdAt: FieldValue.serverTimestamp(),
  });

  await callTelegramApi(botToken, "sendMessage", {
    chat_id: message.chat.id,
    message_thread_id: threadId,
    reply_to_message_id: message.message_id,
    text: `${BOOKING_TYPE_ICON[type] || "📌"} Добавлено в бронирования поездки`,
  });
}

// ---- Ввод из тем Telegram ----
// Тема в семейной супергруппе привязывается к разделу командой /bind, после чего каждое
// обычное сообщение в ней становится записью. Роутинг идёт по message_thread_id, поэтому
// никакого «режима захвата» с состоянием и кнопкой «Стоп» не нужно: где написал — туда и
// легло. Непривязанные темы (обсуждения поездок и т.п.) не трогаем вовсе.

const TOPIC_MODULES = {
  сделать: { key: "tasks", title: "Сделать", icon: "📋" },
  покупки: { key: "shopping", title: "Покупки", icon: "🛒" },
};
const BIND_RE = /^\/bind(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/is;

async function isFamilyMember(telegramId) {
  const snap = await getFirestore().collection("users").doc(String(telegramId)).get();
  return snap.exists;
}

async function getTopicBinding(threadId) {
  const snap = await getFirestore().collection("topic_bindings").doc(String(threadId)).get();
  return snap.exists ? snap.data() : null;
}

async function handleBindCommand(botToken, message) {
  const threadId = message.message_thread_id;
  const replyTo = { chat_id: message.chat.id, message_thread_id: threadId };

  if (!threadId) {
    await sendTelegramMessage(botToken, message.chat.id, "Команду /bind нужно отправить внутри темы.");
    return;
  }
  if (!(await isFamilyMember(message.from.id))) return;

  const requested = ((message.text.match(BIND_RE) || [])[1] || "").trim().toLowerCase();
  const module = TOPIC_MODULES[requested];
  if (!module) {
    const available = Object.keys(TOPIC_MODULES).join(", ");
    await sendTelegramMessage(
      botToken,
      message.chat.id,
      `Не знаю раздел «${requested}». Доступно: ${available}.\nПример: /bind сделать`,
      { message_thread_id: threadId }
    );
    return;
  }

  await getFirestore().collection("topic_bindings").doc(String(threadId)).set({
    chatId: message.chat.id,
    module: module.key,
    boundBy: String(message.from.id),
    createdAt: FieldValue.serverTimestamp(),
  });

  await sendTelegramMessage(
    botToken,
    message.chat.id,
    `${module.icon} Тема привязана к разделу «${module.title}».\nТеперь каждое сообщение здесь становится записью.`,
    { message_thread_id: threadId }
  );
}

// Карточка только что захваченной задачи: срок и исполнитель проставляются кнопками,
// текст перерисовывается после каждого тапа, чтобы было видно текущее состояние.
function captureCardText(task, assigneeLabel) {
  const lines = [`${TOPIC_MODULES.сделать.icon} Добавлено в «Сделать»`, "", `«${task.text}»`];
  const parts = [];
  const due = formatDueDate(task.dueDate);
  if (due) parts.push(`Срок: ${due}`);
  if (assigneeLabel) parts.push(assigneeLabel);
  if (parts.length > 0) lines.push(parts.join(" · "));
  return lines.join("\n");
}

function captureKeyboard(taskId, familyUsers) {
  const rows = [
    [
      { text: "Сегодня", callback_data: `cd0:${taskId}` },
      { text: "Завтра", callback_data: `cd1:${taskId}` },
      { text: "+7 дней", callback_data: `cd7:${taskId}` },
    ],
  ];
  const assignees = familyUsers.map((user) => ({
    text: user.name || user.id,
    callback_data: `ca:${taskId}:${user.id}`,
  }));
  for (let i = 0; i < assignees.length; i += 3) {
    rows.push(assignees.slice(i, i + 3));
  }
  return { inline_keyboard: rows };
}

async function listFamilyUsers() {
  const snap = await getFirestore().collection("users").get();
  return snap.docs.map((d) => ({ id: d.id, name: d.data().name }));
}

// Карточка захваченной покупки. Кнопок срока нет (у покупки его не бывает), количество
// кнопками не задать — оно свободный текст, поэтому сообщение целиком идёт в название,
// а количество при желании проставляется в приложении.
function shoppingCaptureCardText(item, assigneeLabel) {
  const lines = [`${TOPIC_MODULES.покупки.icon} Добавлено в «Покупки»`, "", `«${item.text}»`];
  const parts = [];
  if (item.quantity) parts.push(item.quantity);
  if (assigneeLabel) parts.push(assigneeLabel);
  if (parts.length > 0) lines.push(parts.join(" · "));
  return lines.join("\n");
}

function shoppingCaptureKeyboard(itemId, familyUsers) {
  const buttons = familyUsers.map((user) => ({
    text: user.name || user.id,
    callback_data: `sa:${itemId}:${user.id}`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) {
    rows.push(buttons.slice(i, i + 3));
  }
  return { inline_keyboard: rows };
}

async function refreshShoppingCaptureCard(botToken, chatId, message, itemId) {
  const [itemSnap, familyUsers] = await Promise.all([
    getFirestore().collection("shopping_items").doc(String(itemId)).get(),
    listFamilyUsers(),
  ]);
  if (!itemSnap.exists) return;

  const item = itemSnap.data();
  const assignee = familyUsers.find((user) => user.id === item.assigneeUid);
  await callTelegramApi(botToken, "editMessageText", {
    chat_id: chatId,
    message_id: message.message_id,
    text: shoppingCaptureCardText(item, assignee ? assignee.name || assignee.id : null),
    reply_markup: shoppingCaptureKeyboard(itemId, familyUsers),
  });
}

async function handleTopicCapture(botToken, message) {
  const threadId = message.message_thread_id;
  const binding = await getTopicBinding(threadId);
  if (!binding) return; // тема не привязана — не наше дело
  if (!(await isFamilyMember(message.from.id))) return;

  const db = getFirestore();
  const authorUid = String(message.from.id);
  const text = message.text.trim();
  const familyUsers = await listFamilyUsers();
  const replyOptions = {
    message_thread_id: threadId,
    reply_to_message_id: message.message_id,
  };

  if (binding.module === "tasks") {
    const taskRef = await db.collection("tasks").add({
      text,
      status: "open",
      dueDate: null,
      assigneeUid: null,
      authorUid,
      lastEditedBy: authorUid,
      createdAt: FieldValue.serverTimestamp(),
      reminded1Day: false,
      remindedDueDay: false,
    });

    await sendTelegramMessage(botToken, message.chat.id, captureCardText({ text, dueDate: null }, null), {
      ...replyOptions,
      reply_markup: captureKeyboard(taskRef.id, familyUsers),
    });
    return;
  }

  if (binding.module === "shopping") {
    const itemRef = await db.collection("shopping_items").add({
      text,
      quantity: null,
      status: "active",
      assigneeUid: null,
      authorUid,
      lastEditedBy: authorUid,
      createdAt: FieldValue.serverTimestamp(),
    });

    await sendTelegramMessage(botToken, message.chat.id, shoppingCaptureCardText({ text }, null), {
      ...replyOptions,
      reply_markup: shoppingCaptureKeyboard(itemRef.id, familyUsers),
    });
  }
}

async function refreshCaptureCard(botToken, chatId, message, taskId) {
  const [taskSnap, familyUsers] = await Promise.all([
    getFirestore().collection("tasks").doc(String(taskId)).get(),
    listFamilyUsers(),
  ]);
  if (!taskSnap.exists) return;

  const task = taskSnap.data();
  const assignee = familyUsers.find((user) => user.id === task.assigneeUid);
  await callTelegramApi(botToken, "editMessageText", {
    chat_id: chatId,
    message_id: message.message_id,
    text: captureCardText(task, assignee ? assignee.name || assignee.id : null),
    reply_markup: captureKeyboard(taskId, familyUsers),
  });
}

// ---- Нажатия кнопок под сообщениями о задачах ----

// Разметка только что захваченной задачи — в отличие от действий над задачей,
// доступна любому участнику семьи, потому что карточка общая.
const CAPTURE_ACTIONS = new Set(["cd0", "cd1", "cd7", "ca"]);

async function answerCallback(botToken, callbackQueryId, text) {
  // Ответить обязательно, иначе у нажавшего на кнопке крутятся часики до таймаута.
  await callTelegramApi(botToken, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || "",
  });
}

// Арифметика по строке "ГГГГ-ММ-ДД" в UTC: перевод в локальное время и обратно мог бы
// сдвинуть дату на сутки, а сама дата часового пояса не имеет.
function addDaysToDateStr(dateStr, days) {
  const base = new Date(`${dateStr}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// Действие сделано — дописываем итог в текст и убираем кнопки, чтобы нельзя было
// нажать повторно по уже неактуальной карточке.
async function closeTaskCard(botToken, chatId, message, outcome) {
  await callTelegramApi(botToken, "editMessageText", {
    chat_id: chatId,
    message_id: message.message_id,
    text: `${message.text || ""}\n\n${outcome}`,
    reply_markup: { inline_keyboard: [] },
  });
}

// Нажатия по карточкам покупок. Коллекция другая, поэтому свой разбор, а не ветка в
// handleTaskCallback — общее у них только «достать документ и проверить, чей он».
const SHOPPING_ACTIONS = new Set(["sdone", "sdrop", "sa"]);

async function handleShoppingCallback(botToken, callbackQuery) {
  const [action, itemId] = (callbackQuery.data || "").split(":");
  const message = callbackQuery.message;
  if (!message || !message.chat) {
    await answerCallback(botToken, callbackQuery.id, "Сообщение слишком старое, откройте список в приложении");
    return;
  }

  const itemRef = getFirestore().collection("shopping_items").doc(String(itemId));
  const itemSnap = await itemRef.get();
  if (!itemSnap.exists) {
    await answerCallback(botToken, callbackQuery.id, "Позиция уже удалена");
    return;
  }

  const item = itemSnap.data();
  const actorUid = String(callbackQuery.from.id);

  if (action === "sa") {
    // Карточка захвата висит в общей теме — назначать может любой из семьи, как и у задач.
    if (!(await isFamilyMember(actorUid))) {
      await answerCallback(botToken, callbackQuery.id, "Доступ только участникам семьи");
      return;
    }
    await itemRef.update({
      assigneeUid: callbackQuery.data.split(":")[2] || null,
      lastEditedBy: actorUid,
    });
    await refreshShoppingCaptureCard(botToken, message.chat.id, message, itemId);
    await answerCallback(botToken, callbackQuery.id, "Готово");
    return;
  }

  if (item.assigneeUid !== actorUid && item.authorUid !== actorUid) {
    await answerCallback(botToken, callbackQuery.id, "Это не ваша позиция");
    return;
  }

  const bought = action === "sdone";
  await itemRef.update({
    status: bought ? "bought" : "cancelled",
    closedAt: FieldValue.serverTimestamp(),
  });
  await closeTaskCard(
    botToken,
    message.chat.id,
    message,
    bought ? "✅ Куплено" : "🚫 Убрано как ненужное"
  );
  await answerCallback(botToken, callbackQuery.id, bought ? "Куплено" : "Убрано");
}

async function handleTaskCallback(botToken, callbackQuery) {
  const [action, taskId] = (callbackQuery.data || "").split(":");
  if (!taskId) return;

  // У слишком старого сообщения Telegram присылает callback без message —
  // обращение к message.chat здесь уронило бы обработку апдейта целиком.
  const message = callbackQuery.message;
  if (!message || !message.chat) {
    await answerCallback(botToken, callbackQuery.id, "Сообщение слишком старое, откройте задачу в приложении");
    return;
  }
  const chatId = message.chat.id;

  const taskRef = getFirestore().collection("tasks").doc(String(taskId));
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    await answerCallback(botToken, callbackQuery.id, "Задача уже удалена");
    return;
  }

  const task = taskSnap.data();
  const actorUid = String(callbackQuery.from.id);

  if (CAPTURE_ACTIONS.has(action)) {
    // Карточка захвата висит в общей теме: размечать её может любой из семьи, а не
    // только тот, кто написал сообщение.
    if (!(await isFamilyMember(actorUid))) {
      await answerCallback(botToken, callbackQuery.id, "Доступ только участникам семьи");
      return;
    }

    const updates = { lastEditedBy: actorUid };
    if (action === "ca") {
      updates.assigneeUid = callbackQuery.data.split(":")[2] || null;
    } else {
      updates.dueDate = isoDateInTimeZone(REMINDER_TIMEZONE, { cd0: 0, cd1: 1, cd7: 7 }[action]);
      updates.reminded1Day = false;
      updates.remindedDueDay = false;
    }

    await taskRef.update(updates);
    await refreshCaptureCard(botToken, chatId, message, taskId);
    await answerCallback(botToken, callbackQuery.id, "Готово");
    return;
  }

  if (task.assigneeUid !== actorUid && task.authorUid !== actorUid) {
    await answerCallback(botToken, callbackQuery.id, "Это не ваша задача");
    return;
  }

  if (action === "tpost" || action === "tback") {
    await callTelegramApi(botToken, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: message.message_id,
      reply_markup: action === "tpost" ? taskPostponeKeyboard(taskId) : taskActionsKeyboard(taskId),
    });
    await answerCallback(botToken, callbackQuery.id, "");
    return;
  }

  if (action === "tdone" || action === "tdrop") {
    const done = action === "tdone";
    await taskRef.update({
      status: done ? "done" : "cancelled",
      closedAt: FieldValue.serverTimestamp(),
    });
    await closeTaskCard(botToken, chatId, message, done ? "✅ Сделано" : "🚫 Закрыто как ненужное");
    await answerCallback(botToken, callbackQuery.id, done ? "Готово" : "Закрыто");
    return;
  }

  if (action === "tp1" || action === "tp7") {
    // «Завтра» — всегда завтрашний день; «+7 дней» — от текущего срока задачи,
    // чтобы просроченную сдвигало вперёд от той даты, что уже стоит. Те же правила,
    // что у кнопок переноса в mini-app.
    const today = isoDateInTimeZone(REMINDER_TIMEZONE, 0);
    const newDueDate =
      action === "tp1"
        ? isoDateInTimeZone(REMINDER_TIMEZONE, 1)
        : addDaysToDateStr(task.dueDate || today, 7);

    await taskRef.update({
      dueDate: newDueDate,
      // без сброса флагов перенесённая задача не напомнила бы о себе больше никогда
      reminded1Day: false,
      remindedDueDay: false,
    });
    await closeTaskCard(botToken, chatId, message, `⏰ Перенесено на ${formatDueDate(newDueDate)}`);
    await answerCallback(botToken, callbackQuery.id, "Перенесено");
    return;
  }

  await answerCallback(botToken, callbackQuery.id, "");
}

exports.telegramWebhook = onRequest(
  { secrets: [BOT_TOKEN, WEBHOOK_SECRET] },
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
        if (SHOPPING_ACTIONS.has(action)) {
          await handleShoppingCallback(BOT_TOKEN.value(), callbackQuery);
        } else {
          await handleTaskCallback(BOT_TOKEN.value(), callbackQuery);
        }
      } else if (message && message.text && message.chat.type === "private" && START_RE.test(message.text)) {
        await handleStartCommand(BOT_TOKEN.value(), message);
      } else if (message && message.text && CONFIRM_RE.test(message.text)) {
        await handleConfirmCommand(BOT_TOKEN.value(), message);
      } else if (message && message.text && BIND_RE.test(message.text)) {
        await handleBindCommand(BOT_TOKEN.value(), message);
      } else if (
        message &&
        message.text &&
        !message.text.startsWith("/") &&
        !message.from.is_bot &&
        message.message_thread_id &&
        (message.chat.type === "supergroup" || message.chat.type === "group")
      ) {
        await handleTopicCapture(BOT_TOKEN.value(), message);
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

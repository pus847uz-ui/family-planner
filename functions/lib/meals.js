// Раздел «Приёмы пищи» — в отличие от остальных разделов это не захват записей, а диалог
// с состоянием. Один открывает сессию («Ужинаем?»), отвечает второй; часть веток закрывает
// сессию сразу, и только «не дома» ведёт к обсуждению.
//
// Состояние живёт в отдельной коллекции `meal_sessions`, а не в `plans`: сессия — это
// переписка, а `plans` — итог. Иначе брошенные диалоги засоряли бы приложение.
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { REMINDER_TIMEZONE } = require("./config");
const { isoDateInTimeZone } = require("./dates");
const { sendTelegramMessage, callTelegramApi, answerCallback } = require("./telegram");
const { getUserName, isFamilyMember } = require("./users");

const MEAL_TYPES = {
  breakfast: { title: "Завтрак", question: "Завтракаем?", icon: "🍳" },
  lunch: { title: "Обед", question: "Обедаем?", icon: "🥘" },
  dinner: { title: "Ужин", question: "Ужинаем?", icon: "🍽" },
};

// asking → ответили «да» → asking_place → «не дома» → deciding (шаг 2)
// Закрывающие ветки: declined («нет») и at_home («дома»).
const MEAL_STATUS = {
  ASKING: "asking",
  DECLINED: "declined",
  ASKING_PLACE: "asking_place",
  AT_HOME: "at_home",
  DECIDING: "deciding",
};

const MEAL_ACTIONS = new Set(["mlnew", "ml"]);
// Кириллические команды Telegram не принимает, поэтому `/meal` латиницей, а шаблоны
// под ней — по-русски.
const MEAL_RE = /^\/meal(?:@[A-Za-z0-9_]+)?$/i;

function mealTemplatesKeyboard() {
  return {
    inline_keyboard: [
      Object.entries(MEAL_TYPES).map(([key, meal]) => ({
        text: `${meal.icon} ${meal.title}`,
        callback_data: `mlnew:${key}`,
      })),
    ],
  };
}

// Одна карточка на сессию, переписывается на каждом шаге: видно и вопрос, и кто что
// ответил, и что происходит сейчас.
function mealSessionCardText(session, names) {
  const meal = MEAL_TYPES[session.mealType];
  const lines = [`${meal.icon} ${meal.title}`, `Спросил: ${names.initiator}`, ""];

  if (session.status === MEAL_STATUS.ASKING) {
    lines.push(meal.question);
    return lines.join("\n");
  }

  lines.push(`${meal.question} — ${names.responder}: Да`);

  if (session.status === MEAL_STATUS.DECLINED) {
    return [`${meal.icon} ${meal.title}`, `Спросил: ${names.initiator}`, "", `${meal.question} — ${names.responder}: Нет`, "", "Сессия закрыта."].join("\n");
  }

  if (session.status === MEAL_STATUS.ASKING_PLACE) {
    lines.push("", "Дома или нет?");
  } else if (session.status === MEAL_STATUS.AT_HOME) {
    lines.push(`Дома? — ${names.responder}: Дома`, "", "Сессия закрыта, запись добавлена в приложение.");
  } else if (session.status === MEAL_STATUS.DECIDING) {
    lines.push(`Дома? — ${names.responder}: Не дома`, "", "Где едим? Пишите варианты в тему.");
  }

  return lines.join("\n");
}

function mealSessionKeyboard(sessionId, status) {
  if (status === MEAL_STATUS.ASKING) {
    return {
      inline_keyboard: [
        [
          { text: "Да", callback_data: `ml:${sessionId}:yes` },
          { text: "Нет", callback_data: `ml:${sessionId}:no` },
        ],
      ],
    };
  }
  if (status === MEAL_STATUS.ASKING_PLACE) {
    return {
      inline_keyboard: [
        [
          { text: "🏠 Дома", callback_data: `ml:${sessionId}:home` },
          { text: "🚶 Не дома", callback_data: `ml:${sessionId}:away` },
        ],
      ],
    };
  }
  // закрытые и обсуждаемые сессии — только откат
  return { inline_keyboard: [[{ text: "↩️ Передумали", callback_data: `ml:${sessionId}:undo` }]] };
}

async function sessionNames(session, responderUid) {
  const [initiator, responder] = await Promise.all([
    getUserName(session.initiatorUid),
    getUserName(responderUid || session.responderUid),
  ]);
  return { initiator, responder };
}

async function refreshMealCard(botToken, session, sessionId) {
  const names = await sessionNames(session);
  await callTelegramApi(botToken, "editMessageText", {
    chat_id: session.chatId,
    message_id: session.messageId,
    text: mealSessionCardText(session, names),
    reply_markup: mealSessionKeyboard(sessionId, session.status),
  });
}

// `/meal` — выкладывает в тему три шаблона вопроса. Команда, а не обычное сообщение:
// на шаге обсуждения текст в теме — это обсуждение, и он не должен заводить сессии.
async function handleMealCommand(botToken, message) {
  if (!(await isFamilyMember(message.from.id))) return;
  await sendTelegramMessage(botToken, message.chat.id, "Что обсуждаем?", {
    message_thread_id: message.message_thread_id,
    reply_markup: mealTemplatesKeyboard(),
  });
}

async function startMealSession(botToken, callbackQuery, mealType) {
  const meal = MEAL_TYPES[mealType];
  if (!meal) return;

  const initiatorUid = String(callbackQuery.from.id);
  const message = callbackQuery.message;
  const db = getFirestore();

  const session = {
    mealType,
    status: MEAL_STATUS.ASKING,
    initiatorUid,
    responderUid: null,
    chatId: message.chat.id,
    threadId: message.message_thread_id || null,
    messageId: null,
    planId: null,
    createdAt: FieldValue.serverTimestamp(),
  };
  const sessionRef = await db.collection("meal_sessions").add(session);

  const initiatorName = await getUserName(initiatorUid);
  const text = mealSessionCardText(session, { initiator: initiatorName, responder: "—" });
  const sent = await callTelegramApi(botToken, "sendMessage", {
    chat_id: message.chat.id,
    message_thread_id: message.message_thread_id,
    text,
    reply_markup: mealSessionKeyboard(sessionRef.id, MEAL_STATUS.ASKING),
  });

  if (sent.ok) {
    await sessionRef.update({ messageId: sent.result.message_id });
  }

  // Сообщение с шаблонами больше не нужно — иначе тема быстро зарастёт ими
  await callTelegramApi(botToken, "deleteMessage", {
    chat_id: message.chat.id,
    message_id: message.message_id,
  });
}

// Запись в приложение. `createdFrom` не даёт onPlanCreated завести отдельную тему
// обсуждения: обсуждение уже прошло здесь, вторая тема на тот же ужин — мусор.
async function createMealPlan(session, decidedPlace) {
  const today = isoDateInTimeZone(REMINDER_TIMEZONE, 0);
  const planRef = await getFirestore().collection("plans").add({
    type: "meal",
    title: MEAL_TYPES[session.mealType].title,
    mealDate: today,
    mealTime: null,
    mealType: decidedPlace ? "restaurant" : "home",
    placeOptions: [],
    reactions: {},
    decidedPlace: decidedPlace || null,
    status: "decided",
    createdFrom: "meal_session",
    telegramChatId: null,
    telegramMessageThreadId: null,
    telegramTopicLink: null,
    authorUid: session.initiatorUid,
    createdAt: FieldValue.serverTimestamp(),
  });
  return planRef.id;
}

async function handleMealCallback(botToken, callbackQuery) {
  const [action, arg, answer] = (callbackQuery.data || "").split(":");
  const actorUid = String(callbackQuery.from.id);

  if (!(await isFamilyMember(actorUid))) {
    await answerCallback(botToken, callbackQuery.id, "Доступ только участникам семьи");
    return;
  }

  if (action === "mlnew") {
    await startMealSession(botToken, callbackQuery, arg);
    await answerCallback(botToken, callbackQuery.id, "");
    return;
  }

  const sessionRef = getFirestore().collection("meal_sessions").doc(String(arg));
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    await answerCallback(botToken, callbackQuery.id, "Сессия не найдена");
    return;
  }
  const session = sessionSnap.data();

  if (answer === "undo") {
    // Откат на шаг назад: закрытая сессия снова открыта, обсуждаемая возвращается к вопросу
    const previous =
      session.status === MEAL_STATUS.ASKING_PLACE ? MEAL_STATUS.ASKING : MEAL_STATUS.ASKING_PLACE;
    const updates = { status: previous };
    if (previous === MEAL_STATUS.ASKING) updates.responderUid = null;
    await sessionRef.update(updates);
    await refreshMealCard(botToken, { ...session, ...updates }, arg);
    await answerCallback(botToken, callbackQuery.id, "Вернулись на шаг назад");
    return;
  }

  // Спросивший не отвечает сам себе: он уже высказался тем, что открыл сессию.
  if (actorUid === session.initiatorUid) {
    const responderHint = session.responderUid ? await getUserName(session.responderUid) : "второго участника";
    await answerCallback(botToken, callbackQuery.id, `Вы задали вопрос — ответ за ${responderHint}`);
    return;
  }

  const updates = { responderUid: actorUid };

  if (session.status === MEAL_STATUS.ASKING) {
    updates.status = answer === "yes" ? MEAL_STATUS.ASKING_PLACE : MEAL_STATUS.DECLINED;
  } else if (session.status === MEAL_STATUS.ASKING_PLACE) {
    updates.status = answer === "home" ? MEAL_STATUS.AT_HOME : MEAL_STATUS.DECIDING;
    if (answer === "home") {
      updates.planId = await createMealPlan({ ...session, ...updates }, null);
    }
  } else {
    await answerCallback(botToken, callbackQuery.id, "На этом шаге отвечать уже нечего");
    return;
  }

  await sessionRef.update(updates);
  await refreshMealCard(botToken, { ...session, ...updates }, arg);
  await answerCallback(botToken, callbackQuery.id, "Записал");
}

module.exports = {
  MEAL_TYPES,
  MEAL_STATUS,
  MEAL_ACTIONS,
  MEAL_RE,
  mealTemplatesKeyboard,
  mealSessionCardText,
  mealSessionKeyboard,
  handleMealCommand,
  handleMealCallback,
};

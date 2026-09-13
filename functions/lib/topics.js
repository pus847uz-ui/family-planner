// Привязка тем Telegram к разделам и захват сообщений из них. Зависит от разделов,
// но не наоборот — общий TOPIC_MODULES вынесен в config.js, чтобы не было цикла.
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { REMINDER_TIMEZONE, TOPIC_MODULES } = require("./config");
const { isoDateInTimeZone, zonedToInstant } = require("./dates");
const { sendTelegramMessage } = require("./telegram");
const { isFamilyMember, listFamilyUsers } = require("./users");
const { captureCardText, captureKeyboard } = require("./tasks");
const { shoppingCaptureCardText, shoppingCaptureKeyboard } = require("./shopping");
const { eventCaptureCardText, eventCaptureKeyboard } = require("./events");

// Тема в семейной супергруппе привязывается к разделу командой /bind, после чего каждое
// обычное сообщение в ней становится записью. Роутинг идёт по message_thread_id, поэтому
// никакого «режима захвата» с состоянием и кнопкой «Стоп» не нужно: где написал — туда и
// легло. Непривязанные темы (обсуждения поездок и т.п.) не трогаем вовсе.

const BIND_RE = /^\/bind(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/is;

async function getTopicBinding(threadId) {
  const snap = await getFirestore().collection("topic_bindings").doc(String(threadId)).get();
  return snap.exists ? snap.data() : null;
}

async function handleBindCommand(botToken, message) {
  const threadId = message.message_thread_id;


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
    return;
  }

  if (binding.module === "events") {
    // Дата по умолчанию — сегодня, время пустое («весь день»). Событие без даты не попало
    // бы в запрос повестки (`orderBy("startAt")`) и не появилось бы в приложении вовсе,
    // так что человек не увидел бы того, что только что записал.
    const today = isoDateInTimeZone(REMINDER_TIMEZONE, 0);
    const eventRef = await db.collection("events").add({
      title: text,
      startDate: today,
      startTime: null,
      endDate: today,
      endTime: null,
      place: null,
      locationUrl: null,
      participantUids: [],
      startAt: zonedToInstant(today, null, REMINDER_TIMEZONE),
      authorUid,
      lastEditedBy: authorUid,
      createdAt: FieldValue.serverTimestamp(),
      reminded1Day: false,
      reminded2Hours: false,
    });

    await sendTelegramMessage(
      botToken,
      message.chat.id,
      eventCaptureCardText({ title: text, startDate: today, startTime: null }, null),
      {
        ...replyOptions,
        reply_markup: eventCaptureKeyboard(eventRef.id, familyUsers, []),
      }
    );
  }
}

module.exports = {
  BIND_RE,
  getTopicBinding,
  handleBindCommand,
  handleTopicCapture,
};

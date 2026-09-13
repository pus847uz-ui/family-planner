// Команды бота: /start в личке и /confirm для закрепления бронирований в теме поездки.
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { WEBAPP_URL } = require("./config");
const { callTelegramApi, buildTelegramMessageLink } = require("./telegram");

const BOOKING_TYPE_ICON = { flight: "✈️", hotel: "🏨", car: "🚗" };
// Telegram-клиент в группах иногда дописывает @имя_бота после команды
// (например, "/confirm@family_planner_xyz_bot flight") — обе команды разбираются через regex,
// чтобы не принять "@имя_бота..." за аргумент команды.
const START_RE = /^\/start(?:@[A-Za-z0-9_]+)?$/i;
const CONFIRM_RE = /^\/confirm(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/is;

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

module.exports = {
  BOOKING_TYPE_ICON,
  START_RE,
  CONFIRM_RE,
  handleStartCommand,
  handleConfirmCommand,
};

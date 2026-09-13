// Единственное место, которое обращается к Telegram Bot API.

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

function buildTelegramMessageLink(chatId, threadId, messageId) {
  const internalId = String(chatId).replace(/^-100/, "");
  return `https://t.me/c/${internalId}/${threadId}/${messageId}`;
}

async function answerCallback(botToken, callbackQueryId, text) {
  // Ответить обязательно, иначе у нажавшего на кнопке крутятся часики до таймаута.
  await callTelegramApi(botToken, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || "",
  });
}

// Действие сделано — дописываем итог в текст и убираем кнопки, чтобы нельзя было
// нажать повторно по уже неактуальной карточке.
async function finishCard(botToken, chatId, message, outcome) {
  await callTelegramApi(botToken, "editMessageText", {
    chat_id: chatId,
    message_id: message.message_id,
    text: `${message.text || ""}\n\n${outcome}`,
    reply_markup: { inline_keyboard: [] },
  });
}

module.exports = {
  sendTelegramMessage,
  callTelegramApi,
  buildTopicLink,
  buildTelegramMessageLink,
  answerCallback,
  finishCard,
};

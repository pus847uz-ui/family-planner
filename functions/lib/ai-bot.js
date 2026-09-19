// Команда /ask — вопрос к ИИ о содержимом планировщика.
//
// Только в личке с ботом, и это не техническое ограничение, а суть: вопрос и ответ
// видит лишь тот, кто спросил. В общей теме тот же /ask превратил бы личный запрос
// в сообщение для всей семьи.
const { callTelegramApi } = require("./telegram");
const { isFamilyMember } = require("./users");
const { askModel } = require("./gemini");
const {
  SYSTEM_INSTRUCTION,
  buildContext,
  formatContext,
  getRecentDialogue,
  saveConversation,
} = require("./ai");

const ASK_RE = /^\/ask(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i;

const HELP_TEXT = `Спросите про планы своими словами:

/ask что мне сделать сегодня
/ask когда ближайшее событие
/ask что купить

Я смотрю задачи, покупки, события, планы и регулярные платежи. Переписка видна только вам.`;

// Телеграм режет сообщения длиннее 4096 символов, а модель просили отвечать коротко —
// но обрезать по границе на всякий случай дешевле, чем ловить ошибку отправки.
const MAX_TELEGRAM_TEXT = 4000;

async function handleAskCommand(botToken, geminiKey, message) {
  const chatId = message.chat.id;
  const uid = String(message.from.id);

  if (message.chat.type !== "private") {
    await callTelegramApi(botToken, "sendMessage", {
      chat_id: chatId,
      message_thread_id: message.message_thread_id,
      reply_to_message_id: message.message_id,
      text: "Этот вопрос лучше задать мне в личке — так ответ увидите только вы.",
    });
    return;
  }

  if (!(await isFamilyMember(uid))) return;

  const question = (message.text.match(ASK_RE)[1] || "").trim();
  if (!question) {
    await callTelegramApi(botToken, "sendMessage", { chat_id: chatId, text: HELP_TEXT });
    return;
  }

  // Ответ занимает около секунды — за это время в клиенте успевает появиться «печатает»,
  // иначе пауза выглядит так, будто команда потерялась.
  await callTelegramApi(botToken, "sendChatAction", { chat_id: chatId, action: "typing" });

  try {
    const [context, dialogue] = await Promise.all([buildContext(uid), getRecentDialogue(uid)]);
    const answer = await askModel(
      geminiKey,
      SYSTEM_INSTRUCTION,
      `${formatContext(context)}\n\nВопрос: ${question}`,
      dialogue
    );

    await saveConversation(uid, question, answer);
    await callTelegramApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: answer.slice(0, MAX_TELEGRAM_TEXT),
    });
  } catch (err) {
    console.error("handleAskCommand failed:", err);
    await callTelegramApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "Не получилось спросить у модели. Попробуйте ещё раз через минуту.",
    });
  }
}

module.exports = { ASK_RE, handleAskCommand };

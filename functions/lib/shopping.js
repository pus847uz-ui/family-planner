// Раздел «Покупки»: тексты, клавиатуры и разбор нажатий по позициям списка.
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { TOPIC_MODULES } = require("./config");
const { answerCallback, callTelegramApi, finishCard } = require("./telegram");
const { isFamilyMember, listFamilyUsers } = require("./users");

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
  await finishCard(
    botToken,
    message.chat.id,
    message,
    bought ? "✅ Куплено" : "🚫 Убрано как ненужное"
  );
  await answerCallback(botToken, callbackQuery.id, bought ? "Куплено" : "Убрано");
}

module.exports = {
  shoppingActionsKeyboard,
  shoppingAssignmentMessage,
  shoppingCaptureCardText,
  shoppingCaptureKeyboard,
  refreshShoppingCaptureCard,
  SHOPPING_ACTIONS,
  handleShoppingCallback,
};

// Раздел «Сделать»: тексты, клавиатуры и разбор нажатий по задачам.
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { REMINDER_TIMEZONE, TOPIC_MODULES } = require("./config");
const { formatDueDate, isoDateInTimeZone, addDaysToDateStr } = require("./dates");
const { callTelegramApi, answerCallback, finishCard } = require("./telegram");
const { isFamilyMember, listFamilyUsers } = require("./users");

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

// Разметка только что захваченной задачи — в отличие от действий над задачей,
// доступна любому участнику семьи, потому что карточка общая.
const CAPTURE_ACTIONS = new Set(["cd0", "cd1", "cd7", "ca"]);

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
    await finishCard(botToken, chatId, message, done ? "✅ Сделано" : "🚫 Закрыто как ненужное");
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
    await finishCard(botToken, chatId, message, `⏰ Перенесено на ${formatDueDate(newDueDate)}`);
    await answerCallback(botToken, callbackQuery.id, "Перенесено");
    return;
  }

  await answerCallback(botToken, callbackQuery.id, "");
}

module.exports = {
  assignmentMessage,
  taskActionsKeyboard,
  taskPostponeKeyboard,
  captureCardText,
  captureKeyboard,
  refreshCaptureCard,
  CAPTURE_ACTIONS,
  handleTaskCallback,
};

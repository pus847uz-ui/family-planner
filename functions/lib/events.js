// Раздел «Календарь»: уведомления об участии, календарная сетка из инлайн-кнопок и
// разбор нажатий по ней.
const { getFirestore } = require("firebase-admin/firestore");
const { REMINDER_TIMEZONE, TOPIC_MODULES } = require("./config");
const {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  formatDueDate,
  pad2,
  shiftYearMonth,
  zonedToInstant,
} = require("./dates");
const { sendTelegramMessage, callTelegramApi, answerCallback } = require("./telegram");
const { getUserName, isFamilyMember, listFamilyUsers } = require("./users");

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

// Сетка месяца из инлайн-кнопок. Нативный выбор даты в группе открыть нельзя — кнопка с
// мини-приложением работает только в личном чате, — поэтому календарь рисуется прямо в
// сообщении. Пустые клетки и шапка — кнопки с `noop`, Telegram не умеет неактивные.
function eventCalendarKeyboard(eventId, yearMonth) {
  const [year, month] = yearMonth.split("-").map(Number);
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const rows = [
    [
      { text: "‹", callback_data: `en:${eventId}:${shiftYearMonth(yearMonth, -1)}` },
      { text: `${MONTH_NAMES[month - 1]} ${year}`, callback_data: "noop" },
      { text: "›", callback_data: `en:${eventId}:${shiftYearMonth(yearMonth, 1)}` },
    ],
    WEEKDAY_NAMES.map((name) => ({ text: name, callback_data: "noop" })),
  ];

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push({ text: "·", callback_data: "noop" });
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({
      text: String(day),
      callback_data: `ed:${eventId}:${year}-${pad2(month)}-${pad2(day)}`,
    });
  }
  while (cells.length % 7 !== 0) cells.push({ text: "·", callback_data: "noop" });
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  rows.push([{ text: "← Назад", callback_data: `eb:${eventId}` }]);
  return { inline_keyboard: rows };
}

function eventHoursKeyboard(eventId) {
  const rows = [[{ text: "🌤 Весь день", callback_data: `em:${eventId}:all:day` }]];
  // С шести утра: ночные часы внизу, чтобы частые попадали под палец первыми
  const hours = [...Array(24).keys()].map((h) => (h + 6) % 24);
  for (let i = 0; i < hours.length; i += 6) {
    rows.push(
      hours.slice(i, i + 6).map((hour) => ({
        text: pad2(hour),
        callback_data: `eh:${eventId}:${pad2(hour)}`,
      }))
    );
  }
  rows.push([{ text: "← Назад", callback_data: `eb:${eventId}` }]);
  return { inline_keyboard: rows };
}

function eventMinutesKeyboard(eventId, hour) {
  return {
    inline_keyboard: [
      ["00", "15", "30", "45"].map((minute) => ({
        text: `${hour}:${minute}`,
        callback_data: `em:${eventId}:${hour}:${minute}`,
      })),
      [{ text: "← Назад", callback_data: `eb:${eventId}` }],
    ],
  };
}

function eventCaptureKeyboard(eventId, familyUsers, participantUids) {
  const participants = participantUids || [];
  const rows = [
    [
      { text: "📅 Дата", callback_data: `ecal:${eventId}` },
      { text: "🕐 Время", callback_data: `etime:${eventId}` },
    ],
  ];
  const chips = familyUsers.map((user) => ({
    text: (participants.includes(user.id) ? "✓ " : "") + (user.name || user.id),
    callback_data: `ep:${eventId}:${user.id}`,
  }));
  for (let i = 0; i < chips.length; i += 3) rows.push(chips.slice(i, i + 3));
  return { inline_keyboard: rows };
}

function eventCaptureCardText(eventItem, participantLabel) {
  const lines = [`${TOPIC_MODULES.календарь.icon} Добавлено в «Календарь»`, "", `«${eventItem.title}»`];
  const parts = [eventWhenText(eventItem)];
  if (participantLabel) parts.push(participantLabel);
  lines.push(parts.join(" · "));
  return lines.join("\n");
}

async function refreshEventCaptureCard(botToken, chatId, message, eventId, keyboard) {
  const [eventSnap, familyUsers] = await Promise.all([
    getFirestore().collection("events").doc(String(eventId)).get(),
    listFamilyUsers(),
  ]);
  if (!eventSnap.exists) return;

  const eventItem = eventSnap.data();
  const names = (eventItem.participantUids || [])
    .map((uid) => {
      const user = familyUsers.find((u) => u.id === uid);
      return user ? user.name || user.id : null;
    })
    .filter(Boolean)
    .join(", ");

  await callTelegramApi(botToken, "editMessageText", {
    chat_id: chatId,
    message_id: message.message_id,
    text: eventCaptureCardText(eventItem, names || null),
    reply_markup:
      keyboard || eventCaptureKeyboard(eventId, familyUsers, eventItem.participantUids),
  });
}

// Разметка события с карточки захвата: календарь, часы, минуты, участники.
const EVENT_ACTIONS = new Set(["ecal", "etime", "en", "ed", "eh", "em", "ep", "eb"]);

async function handleEventCallback(botToken, callbackQuery) {
  const dataParts = (callbackQuery.data || "").split(":");
  const [action, eventId] = dataParts;
  const message = callbackQuery.message;
  if (!message || !message.chat) {
    await answerCallback(botToken, callbackQuery.id, "Сообщение слишком старое, откройте событие в приложении");
    return;
  }

  const actorUid = String(callbackQuery.from.id);
  if (!(await isFamilyMember(actorUid))) {
    await answerCallback(botToken, callbackQuery.id, "Доступ только участникам семьи");
    return;
  }

  const eventRef = getFirestore().collection("events").doc(String(eventId));
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) {
    await answerCallback(botToken, callbackQuery.id, "Событие уже удалено");
    return;
  }
  const eventItem = eventSnap.data();
  const chatId = message.chat.id;

  // Переключение вида клавиатуры — сам документ не трогаем
  if (action === "ecal" || action === "en" || action === "etime" || action === "eh" || action === "eb") {
    let keyboard;
    if (action === "ecal") keyboard = eventCalendarKeyboard(eventId, eventItem.startDate.slice(0, 7));
    else if (action === "en") keyboard = eventCalendarKeyboard(eventId, dataParts[2]);
    else if (action === "etime") keyboard = eventHoursKeyboard(eventId);
    else if (action === "eh") keyboard = eventMinutesKeyboard(eventId, dataParts[2]);
    else keyboard = null; // eb — назад к основной карточке

    await refreshEventCaptureCard(botToken, chatId, message, eventId, keyboard);
    await answerCallback(botToken, callbackQuery.id, "");
    return;
  }

  const updates = { lastEditedBy: actorUid };

  if (action === "ed") {
    const newDate = dataParts[2];
    updates.startDate = newDate;
    updates.endDate = newDate;
    updates.startAt = zonedToInstant(newDate, eventItem.startTime, REMINDER_TIMEZONE);
  } else if (action === "em") {
    const allDay = dataParts[2] === "all";
    const newTime = allDay ? null : `${dataParts[2]}:${dataParts[3]}`;
    updates.startTime = newTime;
    updates.startAt = zonedToInstant(eventItem.startDate, newTime, REMINDER_TIMEZONE);
  } else if (action === "ep") {
    const uid = dataParts[2];
    const current = eventItem.participantUids || [];
    updates.participantUids = current.includes(uid)
      ? current.filter((id) => id !== uid)
      : [...current, uid];
  }

  // Время или дата могли поехать — напоминания должны сработать заново
  if (action === "ed" || action === "em") {
    updates.reminded1Day = false;
    updates.reminded2Hours = false;
  }

  await eventRef.update(updates);
  await refreshEventCaptureCard(botToken, chatId, message, eventId, null);
  await answerCallback(botToken, callbackQuery.id, "Готово");
}

module.exports = {
  eventWhenText,
  eventNotificationMessage,
  eventKeyboard,
  notifyEventParticipants,
  eventCalendarKeyboard,
  eventHoursKeyboard,
  eventMinutesKeyboard,
  eventCaptureKeyboard,
  eventCaptureCardText,
  refreshEventCaptureCard,
  EVENT_ACTIONS,
  handleEventCallback,
};

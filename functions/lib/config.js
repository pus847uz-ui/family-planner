// Секреты и общие константы. initializeApp() живёт здесь же: модуль требуется всеми
// остальными, а Node кеширует модули, поэтому инициализация случается ровно один раз.
//
// TOPIC_MODULES тоже здесь, а не в topics.js, чтобы не было цикла: разделы (tasks/shopping/
// events) берут отсюда свои иконки и названия, а topics.js требует сами разделы.
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");

initializeApp();

const BOT_TOKEN = defineSecret("BOT_TOKEN");
const WEBHOOK_SECRET = defineSecret("WEBHOOK_SECRET");
// Приватная супергруппа с включённым режимом Topics — обсуждения поездок/досуга/приёмов пищи.
// Не секрет (просто числовой ID чата), поэтому хранится как обычная константа.
const TOPICS_CHAT_ID = -1004324845791;
const WEBAPP_URL = "https://pus847uz-ui.github.io/family-planner/";
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

// Ташкент, а не Карачи: смещение то же (UTC+5), но пояс выбран осознанно, а не
// случайно — время в напоминаниях должно совпадать с тем, по которому живёт семья.
const REMINDER_TIMEZONE = "Asia/Tashkent";

const TOPIC_MODULES = {
  сделать: { key: "tasks", title: "Сделать", icon: "📋" },
  покупки: { key: "shopping", title: "Покупки", icon: "🛒" },
  календарь: { key: "events", title: "Календарь", icon: "📅" },
};

module.exports = {
  BOT_TOKEN,
  WEBHOOK_SECRET,
  TOPICS_CHAT_ID,
  WEBAPP_URL,
  MAX_INIT_DATA_AGE_SECONDS,
  REMINDER_TIMEZONE,
  TOPIC_MODULES,
};

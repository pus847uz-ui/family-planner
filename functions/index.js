const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
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

const REMINDER_TIMEZONE = "Asia/Karachi";

function isoDateInTimeZone(timeZone, offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

async function sendTelegramMessage(botToken, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) {
    console.error("sendTelegramMessage failed:", await response.text());
  }
}

exports.sendTaskReminders = onSchedule(
  { schedule: "0 9 * * *", timeZone: REMINDER_TIMEZONE, secrets: [BOT_TOKEN] },
  async () => {
    const db = getFirestore();
    const today = isoDateInTimeZone(REMINDER_TIMEZONE, 0);
    const tomorrow = isoDateInTimeZone(REMINDER_TIMEZONE, 1);

    const [tasksSnap, usersSnap] = await Promise.all([
      db.collection("tasks").where("status", "==", "open").get(),
      db.collection("users").get(),
    ]);
    const chatIds = usersSnap.docs.map((d) => d.id);

    for (const taskDoc of tasksSnap.docs) {
      const task = taskDoc.data();
      if (!task.dueDate) continue;

      let messageText = null;
      const updates = {};

      if (task.dueDate === tomorrow && !task.reminded1Day) {
        messageText = `Напоминание: завтра дедлайн задачи "${task.text}"`;
        updates.reminded1Day = true;
      } else if (task.dueDate === today && !task.remindedDueDay) {
        messageText = `Напоминание: сегодня дедлайн задачи "${task.text}"`;
        updates.remindedDueDay = true;
      }

      if (messageText) {
        await Promise.all(
          chatIds.map((chatId) => sendTelegramMessage(BOT_TOKEN.value(), chatId, messageText))
        );
        await taskDoc.ref.update(updates);
      }
    }
  }
);

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
        await Promise.all(
          chatIds.map((chatId) => sendTelegramMessage(BOT_TOKEN.value(), chatId, messageText))
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

  const type = message.text.slice("/confirm".length).trim() || "other";
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

exports.telegramWebhook = onRequest(
  { secrets: [BOT_TOKEN, WEBHOOK_SECRET] },
  async (req, res) => {
    if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET.value()) {
      res.status(401).send("Unauthorized");
      return;
    }

    const message = req.body && req.body.message;

    try {
      if (message && message.text === "/start" && message.chat.type === "private") {
        await handleStartCommand(BOT_TOKEN.value(), message);
      } else if (message && message.text && message.text.startsWith("/confirm")) {
        await handleConfirmCommand(BOT_TOKEN.value(), message);
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

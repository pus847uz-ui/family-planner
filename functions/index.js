const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();

const BOT_TOKEN = defineSecret("BOT_TOKEN");
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


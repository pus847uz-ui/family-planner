const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

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

      const whitelistDoc = await admin.firestore().collection("users").doc(uid).get();
      if (!whitelistDoc.exists) {
        res.status(403).json({ error: "Not a family member" });
        return;
      }

      const customToken = await admin.auth().createCustomToken(uid);
      res.status(200).json({ token: customToken });
    } catch (err) {
      console.error("verifyInitData failed:", err);
      res.status(500).json({ error: "Internal error", detail: err.message });
    }
  }
);

exports.helloWorld = onRequest((req, res) => {
  res.send("Hello from Firebase Cloud Functions!");
});

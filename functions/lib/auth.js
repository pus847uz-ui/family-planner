const crypto = require("crypto");
const { MAX_INIT_DATA_AGE_SECONDS } = require("./config");

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

module.exports = { checkTelegramInitData };

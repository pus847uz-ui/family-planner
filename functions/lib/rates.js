// Курсы валют от ЦБ Узбекистана: https://cbu.uz/ru/arkhiv-kursov-valyut/json/
//
// Источник официальный, открытый и не требует ключа, а курсы даёт сразу в сумах —
// поэтому сум и выбран базовой валютой: любой другой базой пришлось бы пересчитывать
// дважды и терять точность на каждом шаге.
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const RATES_URL = "https://cbu.uz/ru/arkhiv-kursov-valyut/json/";

const BASE_CURRENCY = "UZS";
// Четыре валюты семьи. ЦБ отдаёт семь десятков, но хранить все — значит показывать их
// в выборе, а лишние строки в списке мешают каждый раз, когда вводишь трату.
const CURRENCIES = ["UZS", "USD", "EUR", "RUB"];

async function fetchRatesFromCbu() {
  const response = await fetch(RATES_URL);
  if (!response.ok) throw new Error(`ЦБ ответил ${response.status}`);

  const list = await response.json();
  // Сум к суму — единица, и в ответе ЦБ его, разумеется, нет.
  const rates = { [BASE_CURRENCY]: 1 };

  for (const item of list) {
    if (!CURRENCIES.includes(item.Ccy)) continue;
    const rate = Number(item.Rate);
    // Nominal у доллара и евро единица, но у части валют курс дан за 10 или 100 единиц.
    // Без деления суммы разъехались бы на порядок — и незаметно, потому что выглядели
    // бы правдоподобно.
    const nominal = Number(item.Nominal) || 1;
    if (!Number.isFinite(rate) || rate <= 0) continue;
    rates[item.Ccy] = rate / nominal;
  }

  const missing = CURRENCIES.filter((c) => !(c in rates));
  if (missing.length > 0) throw new Error(`ЦБ не дал курс: ${missing.join(", ")}`);

  return rates;
}

// Курс за день лежит отдельным документом с датой в качестве id: так курс на день траты
// достаётся одним чтением по известному ключу, без запросов с сортировкой.
async function saveRatesForDate(isoDate, rates) {
  await getFirestore().collection("exchange_rates").doc(isoDate).set({
    rates,
    source: "cbu.uz",
    fetchedAt: FieldValue.serverTimestamp(),
  });
}

// В выходные и праздники ЦБ курс не публикует, поэтому документа на сегодня может не
// быть. Отходим назад до последнего известного — курс выходного дня и есть пятничный.
const MAX_LOOKBACK_DAYS = 10;

async function getRatesForDate(isoDate, addDaysToDateStr) {
  const db = getFirestore();
  let date = isoDate;

  for (let i = 0; i < MAX_LOOKBACK_DAYS; i += 1) {
    const snap = await db.collection("exchange_rates").doc(date).get();
    if (snap.exists) return { date, rates: snap.data().rates };
    date = addDaysToDateStr(date, -1);
  }
  return null;
}

// Сумма в базовой валюте. Возвращает null, когда курса нет: пусть вызывающий решает,
// показать сумму как есть или промолчать, — выдуманный курс хуже отсутствующего.
function toBaseAmount(amount, currency, rates) {
  if (!rates) return null;
  const rate = currency === BASE_CURRENCY ? 1 : rates[currency];
  if (!rate) return null;
  return amount * rate;
}

module.exports = {
  BASE_CURRENCY,
  CURRENCIES,
  RATES_URL,
  fetchRatesFromCbu,
  saveRatesForDate,
  getRatesForDate,
  toBaseAmount,
};

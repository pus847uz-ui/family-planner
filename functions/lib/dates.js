// Даты и часовые пояса. Ничего не знают ни о сети, ни о Firestore, поэтому проверяются
// подстановкой выдуманных данных — так и проверялся перевод времени между поясом и UTC.

const MONTH_NAMES = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];
const WEEKDAY_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function isoDateInTimeZone(timeZone, offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

// Какой это был день по нашему поясу для произвольного момента времени. Нужно, чтобы
// отобрать закрытое «сегодня», не вычисляя вручную смещение пояса от UTC.
function isoDateOfInstant(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(instant);
}

function timeZoneOffsetMinutes(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - instant.getTime()) / 60000;
}

// «15.09.2026 18:30 по нашему поясу» → момент времени. Смещение берётся у Intl, а не
// пишется руками рядом с названием пояса: захардкоженный «+05:00» разъехался бы с
// константой пояса молча, и события уехали бы на часы.
function zonedToInstant(dateStr, timeStr, timeZone) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = (timeStr || "00:00").split(":").map(Number);
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = timeZoneOffsetMinutes(new Date(naiveUtc), timeZone);
  return new Date(naiveUtc - offset * 60000);
}

function formatDueDate(dueDate) {
  if (!dueDate) return null;
  const [year, month, day] = dueDate.split("-");
  return `${day}.${month}.${year}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function shiftYearMonth(yearMonth, delta) {
  const [year, month] = yearMonth.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}`;
}

// Какого числа платёж списывается в конкретном месяце. День берётся из настройки, но
// 31-го в феврале не бывает — в коротком месяце платёж съезжает на последний день, как
// это делают банки. Без сдвига платёж с 29-го по 31-е просто пропускал бы февраль,
// апрель, июнь, сентябрь и ноябрь.
function paymentDateInMonth(yearMonth, dueDay) {
  const [year, month] = yearMonth.split("-").map(Number);
  // Нулевой день следующего месяца — это последний день текущего.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${yearMonth}-${pad2(Math.min(dueDay, daysInMonth))}`;
}

// День недели: 1 — понедельник, 7 — воскресенье. Такая же нумерация в ISO и в том, как
// о неделе говорят вслух, в отличие от getUTCDay() с воскресеньем в нуле.
function weekdayOfDateStr(dateStr) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

// Арифметика по строке "ГГГГ-ММ-ДД" в UTC: перевод в локальное время и обратно мог бы
// сдвинуть дату на сутки, а сама дата часового пояса не имеет.
function addDaysToDateStr(dateStr, days) {
  const base = new Date(`${dateStr}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

module.exports = {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  isoDateInTimeZone,
  isoDateOfInstant,
  timeZoneOffsetMinutes,
  zonedToInstant,
  formatDueDate,
  pad2,
  shiftYearMonth,
  paymentDateInMonth,
  weekdayOfDateStr,
  addDaysToDateStr,
};

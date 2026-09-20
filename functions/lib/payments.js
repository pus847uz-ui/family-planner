// Периодичность регулярных платежей: когда платёж наступает и во что обходится в месяц.
//
// Чистые функции без Firestore — расписание проверяется прогоном по календарю, а не
// ожиданием нужного числа. Тот же модуль использует приложение через свою копию в
// index.html: логика простая, а тащить сборку ради одного файла незачем.
const { paymentDateInMonth, weekdayOfDateStr, pad2 } = require("./dates");

const PERIODS = ["monthly", "weekly", "yearly"];

// Во сколько платежей в году обходится каждая периодичность. Делим на 12 и получаем
// месячную стоимость: еженедельный платёж — это не четыре платежа в месяц, а 52 в год,
// иначе итог занижается почти на десятую.
const PAYMENTS_PER_YEAR = { monthly: 12, weekly: 52, yearly: 1 };

function periodOf(payment) {
  return PERIODS.includes(payment.period) ? payment.period : "monthly";
}

// Платёж закончился или ещё не начался. Срок действия — главное, чего не хватало:
// у секций и курсов он всегда есть, и без него напоминания продолжались бы вечно.
function isWithinTerm(payment, isoDate) {
  if (payment.startsOn && isoDate < payment.startsOn) return false;
  if (payment.endsOn && isoDate > payment.endsOn) return false;
  return true;
}

// Наступает ли платёж именно в этот день.
function isPaymentDueOn(payment, isoDate) {
  if (!isWithinTerm(payment, isoDate)) return false;

  const period = periodOf(payment);

  if (period === "weekly") {
    return weekdayOfDateStr(isoDate) === Number(payment.dueWeekday);
  }

  if (period === "yearly") {
    const month = pad2(Number(payment.dueMonth) || 1);
    // 29 февраля в невисокосный год съезжает на 28-е — тем же правилом, что и 31-е
    // число в коротком месяце, иначе платёж пропускал бы три года из четырёх.
    const due = paymentDateInMonth(`${isoDate.slice(0, 4)}-${month}`, Number(payment.dueDay) || 1);
    return isoDate === due;
  }

  return isoDate === paymentDateInMonth(isoDate.slice(0, 7), Number(payment.dueDay) || 1);
}

// Ближайший платёж, начиная с указанной даты. Дальше года не ищем: годовой платёж
// найдётся внутри этого окна, а у закончившегося срока следующего платежа нет вовсе.
function nextPaymentDate(payment, fromIsoDate, addDaysToDateStr) {
  let date = fromIsoDate;
  for (let i = 0; i <= 366; i += 1) {
    if (isPaymentDueOn(payment, date)) return date;
    date = addDaysToDateStr(date, 1);
  }
  return null;
}

// Во что платёж обходится в месяц. Нужно для общего итога: складывать еженедельный
// платёж с годовым напрямую бессмысленно.
function monthlyCost(payment, amount) {
  return (amount * PAYMENTS_PER_YEAR[periodOf(payment)]) / 12;
}

module.exports = {
  PERIODS,
  PAYMENTS_PER_YEAR,
  periodOf,
  isWithinTerm,
  isPaymentDueOn,
  nextPaymentDate,
  monthlyCost,
};

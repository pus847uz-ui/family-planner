// Тексты утренней и вечерней сводок. Чистые функции.
const { formatDueDate } = require("./dates");

function sortByDueDate(a, b) {
  return (a.dueDate || "").localeCompare(b.dueDate || "");
}

function pluralRu(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function morningSummaryText(overdue, dueToday, shoppingTotal, shoppingMine) {
  const lines = ["☀️ На сегодня:"];
  if (overdue.length > 0) {
    lines.push("", "🔴 Просрочено:");
    overdue.forEach((task) => lines.push(`• ${task.text} (${formatDueDate(task.dueDate)})`));
  }
  if (dueToday.length > 0) {
    lines.push("", "📋 Сегодня:");
    dueToday.forEach((task) => lines.push(`• ${task.text}`));
  }
  if (shoppingTotal > 0) {
    const word = pluralRu(shoppingTotal, "позиция", "позиции", "позиций");
    lines.push(
      "",
      shoppingMine > 0
        ? `🛒 В списке покупок ${shoppingTotal} ${word}, из них на вас ${shoppingMine}`
        : `🛒 В списке покупок ${shoppingTotal} ${word}`
    );
  }
  return lines.join("\n");
}

function eveningSummaryText(closedToday, pendingCount) {
  const lines = ["🌙 Итоги дня"];

  if (closedToday.length > 0) {
    lines.push("", "Закрыто сегодня:");
    closedToday.forEach((task) =>
      lines.push(`${task.status === "done" ? "✅" : "🚫"} ${task.text}`)
    );
  }

  if (pendingCount === 0) {
    lines.push("", "На сегодня всё закрыто 👍");
  } else {
    lines.push("", `Осталось незакрытым: ${pendingCount}`);
  }

  return lines.join("\n");
}

function pendingTaskCardText(task) {
  const lines = [`❓ Не закрыто: «${task.text}»`];
  const due = formatDueDate(task.dueDate);
  if (due) lines.push(`Срок: ${due}`);
  return lines.join("\n");
}

module.exports = {
  sortByDueDate,
  pluralRu,
  morningSummaryText,
  eveningSummaryText,
  pendingTaskCardText,
};

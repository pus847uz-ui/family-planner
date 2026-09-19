// Сбор контекста для ИИ и приватная история вопросов.
//
// Контекст — общий: задачи и покупки в планировщике и так видны обоим, поэтому модель
// получает их целиком с пометкой, на кого что назначено. Приватна только история
// вопросов: она лежит в подколлекции пользователя, и правила Firestore закрывают её
// от второго участника семьи.
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { listFamilyUsers } = require("./users");
const { isoDateInTimeZone } = require("./dates");
const { REMINDER_TIMEZONE } = require("./config");
const { PLAN_TYPE_TITLE, isClosedStatus } = require("./plans");

const SYSTEM_INSTRUCTION = `Ты помощник семейного планировщика. Отвечай на русском языке.

Правила:
- Отвечай коротко: две-три фразы, если вопрос не требует перечисления.
- Опирайся только на данные из контекста. Если нужного там нет, так и скажи.
- Никогда не выдумывай задачи, сроки, события и суммы.
- Даты называй по-человечески: «завтра», «в пятницу», «12 марта».

Ты только читаешь записи и ничего не создаёшь, не меняешь и не закрываешь, напоминания
ставить тоже не умеешь. Когда тебя прямо просят это сделать — скажи, что не умеешь, и
подскажи, где это делается: задачи — тема «Сделать», покупки — «Покупки», события —
«Календарь», еда — «Еда»; текст сообщения в теме сразу становится записью, а срок и
исполнитель ставятся кнопками под ней. Никогда не предлагай попросить об этом тебя и
не отвечай так, будто запись всё-таки появится.

Эта подсказка нужна только в ответ на просьбу что-то сделать. Если человек просто
спросил, а ответа в контексте нет, скажи, что таких данных нет, и на этом остановись —
темы и кнопки не упоминай.

У каждой записи в скобках указано, на кого она назначена. «Мне», «у меня», «мои» в
вопросе — это про того, кто спрашивает: его имя названо в первой строке контекста.
Чужие записи в такой ответ не включай, но если спросили про семью в целом или про
конкретного человека — перечисляй его.`;

// Сколько записей каждого вида отдаём модели. Ограничение не про деньги, а про
// внимание: в длинном списке модель начинает терять отдельные строки.
const LIMIT = 20;

function nameOf(usersById, uid) {
  if (!uid) return null;
  return usersById.get(String(uid)) || null;
}

async function buildContext(uid) {
  const db = getFirestore();
  const today = isoDateInTimeZone(REMINDER_TIMEZONE, 0);

  const [users, tasksSnap, shoppingSnap, eventsSnap, plansSnap, paymentsSnap] = await Promise.all([
    listFamilyUsers(),
    db.collection("tasks").where("status", "==", "open").get(),
    db.collection("shopping_items").where("status", "==", "active").get(),
    db.collection("events").where("startDate", ">=", today).orderBy("startDate").limit(LIMIT).get(),
    db.collection("plans").get(),
    db.collection("recurring_payments").where("status", "==", "active").get(),
  ]);

  const usersById = new Map(users.map((u) => [String(u.id), u.name]));

  return {
    today,
    me: nameOf(usersById, uid) || "участник семьи",
    tasks: tasksSnap.docs.slice(0, LIMIT).map((d) => {
      const t = d.data();
      return { text: t.text, dueDate: t.dueDate, assignee: nameOf(usersById, t.assigneeUid) };
    }),
    shopping: shoppingSnap.docs.slice(0, LIMIT).map((d) => {
      const s = d.data();
      return { text: s.text, quantity: s.quantity, assignee: nameOf(usersById, s.assigneeUid) };
    }),
    events: eventsSnap.docs.map((d) => {
      const e = d.data();
      return { title: e.title, date: e.startDate, time: e.startTime, place: e.place };
    }),
    plans: plansSnap.docs
      .map((d) => d.data())
      .filter((p) => !isClosedStatus(p.type, p.status))
      .slice(0, LIMIT)
      .map((p) => ({ title: p.title, type: PLAN_TYPE_TITLE[p.type] || p.type })),
    payments: paymentsSnap.docs.slice(0, LIMIT).map((d) => {
      const p = d.data();
      return { title: p.title, amount: p.amount, currency: p.currency, dueDay: p.dueDay };
    }),
  };
}

// Плоский текст, а не JSON: модель одинаково хорошо читает оба, но по тексту заметно
// проще глазами понять, что она видела, когда ответ вышел странным.
function formatContext(ctx) {
  const lines = [`Сегодня ${ctx.today}. Спрашивает: ${ctx.me}.`];

  if (ctx.tasks.length > 0) {
    lines.push("", "Открытые задачи:");
    ctx.tasks.forEach((t) => {
      const parts = [];
      if (t.assignee) parts.push(`на ${t.assignee}`);
      if (t.dueDate) parts.push(`срок ${t.dueDate}`);
      lines.push(`- ${t.text}${parts.length ? ` (${parts.join(", ")})` : " (ничей, без срока)"}`);
    });
  }

  if (ctx.shopping.length > 0) {
    lines.push("", "Список покупок:");
    ctx.shopping.forEach((s) => {
      const parts = [];
      if (s.quantity) parts.push(String(s.quantity));
      if (s.assignee) parts.push(`на ${s.assignee}`);
      lines.push(`- ${s.text}${parts.length ? ` (${parts.join(", ")})` : ""}`);
    });
  }

  if (ctx.events.length > 0) {
    lines.push("", "Ближайшие события:");
    ctx.events.forEach((e) => {
      const parts = [e.date];
      if (e.time) parts.push(e.time);
      if (e.place) parts.push(e.place);
      lines.push(`- ${e.title} (${parts.join(", ")})`);
    });
  }

  if (ctx.plans.length > 0) {
    lines.push("", "Планы в работе:");
    ctx.plans.forEach((p) => lines.push(`- ${p.title} (${p.type})`));
  }

  if (ctx.payments.length > 0) {
    lines.push("", "Регулярные платежи:");
    ctx.payments.forEach((p) =>
      lines.push(`- ${p.title}: ${p.amount} ${p.currency || ""}, ${p.dueDay} числа`)
    );
  }

  if (lines.length === 1) lines.push("", "Записей в планировщике сейчас нет.");

  return lines.join("\n");
}

function conversationsRef(uid) {
  return getFirestore().collection("users").doc(String(uid)).collection("ai_conversations");
}

async function saveConversation(uid, question, answer) {
  const ref = await conversationsRef(uid).add({
    question,
    answer,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function getConversationHistory(uid, limit = 10) {
  const snap = await conversationsRef(uid).orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((d) => {
    const c = d.data();
    return {
      id: d.id,
      question: c.question,
      answer: c.answer,
      // Timestamp не переживает сериализацию в callable-ответе, а клиенту нужна только
      // отметка времени для подписи под вопросом.
      createdAt: c.createdAt ? c.createdAt.toDate().toISOString() : null,
    };
  });
}

async function clearConversationHistory(uid) {
  const snap = await conversationsRef(uid).get();
  const db = getFirestore();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}

module.exports = {
  SYSTEM_INSTRUCTION,
  buildContext,
  formatContext,
  saveConversation,
  getConversationHistory,
  clearConversationHistory,
};

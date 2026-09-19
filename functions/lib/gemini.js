// Единственное место, где живёт знание о конкретной модели: остальной код зовёт
// askModel() и про Gemini ничего не знает — так провайдера можно заменить, не трогая
// сбор контекста и обработчики.
const { GoogleGenAI } = require("@google/genai");

// Вопрос к планировщику — это пересказ уже собранного контекста, рассуждать тут не над
// чем. Лёгкая модель отвечает за секунду и расходует квоту медленнее старших.
const MODEL = "gemini-3.5-flash-lite";

// Клиент дешёвый, но держать его между вызовами всё равно выгодно: инстанс функции
// живёт несколько минут и успевает обслужить пачку вопросов.
let client = null;

function getClient(apiKey) {
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

// `history` — предыдущие пары в хронологическом порядке, [{question, answer}]. Уходят
// отдельными ходами, а не вклейкой в текст вопроса: так модель понимает, где чья
// реплика, и «а во сколько?» цепляется за прошлый ответ, а не за строку контекста.
async function askModel(apiKey, systemInstruction, prompt, history = []) {
  const contents = [];
  history.forEach((turn) => {
    contents.push({ role: "user", parts: [{ text: turn.question }] });
    contents.push({ role: "model", parts: [{ text: turn.answer }] });
  });
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const response = await getClient(apiKey).models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction,
      // Ответ пересказывает факты из контекста, а не сочиняет: низкая температура
      // заметно снижает шанс, что модель допишет несуществующую задачу.
      temperature: 0.2,
      maxOutputTokens: 800,
    },
  });

  const text = (response.text || "").trim();
  if (!text) throw new Error("Модель вернула пустой ответ");
  return text;
}

module.exports = { askModel, MODEL };

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

async function askModel(apiKey, systemInstruction, prompt) {
  const response = await getClient(apiKey).models.generateContent({
    model: MODEL,
    contents: prompt,
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

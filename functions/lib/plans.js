// Поездки, досуг и приёмы пищи: типы планов и правило «план закрыт».

const PLAN_TYPES = ["trip", "leisure", "meal"];
const PLAN_TYPE_EMOJI = { trip: "✈️", leisure: "🎲", meal: "🍽" };
const PLAN_TYPE_TITLE = { trip: "Поездка", leisure: "Досуг", meal: "Приём пищи" };

function isClosedStatus(type, status) {
  if (type === "trip") return status === "completed";
  if (type === "leisure") return status === "decided";
  if (type === "meal") return status === "decided";
  return false;
}

module.exports = { PLAN_TYPES, PLAN_TYPE_EMOJI, PLAN_TYPE_TITLE, isClosedStatus };

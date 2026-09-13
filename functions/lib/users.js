const { getFirestore } = require("firebase-admin/firestore");

// Id документа в `users` — это и есть telegram id участника, поэтому `assigneeUid`
// можно передавать в Bot API как `chat_id` напрямую, ничего дополнительно не храня.

async function getUserName(uid) {
  if (!uid) return "—";
  const snap = await getFirestore().collection("users").doc(String(uid)).get();
  return (snap.exists && snap.data().name) || String(uid);
}

async function isFamilyMember(telegramId) {
  const snap = await getFirestore().collection("users").doc(String(telegramId)).get();
  return snap.exists;
}

async function listFamilyUsers() {
  const snap = await getFirestore().collection("users").get();
  return snap.docs.map((d) => ({ id: d.id, name: d.data().name }));
}

module.exports = { getUserName, isFamilyMember, listFamilyUsers };

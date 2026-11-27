// Telegram reports for the Woodline orders app. Run by GitHub Actions (.github/workflows/telegram.yml).
//   MODE=setup  — remember who wrote to the bot, so reports go to that chat
//   MODE=daily  — morning summary (orders + note reminders) + clean the trash (orders deleted more than 20 days ago)
//   MODE=weekly — summary + CSV and full JSON backup of all orders
// Secrets: FIREBASE_SERVICE_ACCOUNT (service-account JSON), TELEGRAM_BOT_TOKEN.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { buildDaily, buildCSV, expiredTrash, todayISO } from './lib.mjs';

const { MODE = 'daily', FIREBASE_SERVICE_ACCOUNT, TELEGRAM_BOT_TOKEN, APP_URL = '' } = process.env;
if (!FIREBASE_SERVICE_ACCOUNT || !TELEGRAM_BOT_TOKEN) {
  console.error('Нет секретов FIREBASE_SERVICE_ACCOUNT или TELEGRAM_BOT_TOKEN в настройках репозитория.');
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();
const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const cfgRef = db.doc('config/telegram');

async function tg(method, body) {
  const isForm = body instanceof FormData;
  const r = await fetch(`${API}/${method}`, { method: 'POST', body: isForm ? body : JSON.stringify(body), headers: isForm ? {} : { 'content-type': 'application/json' } });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}

async function setup() {
  const updates = await tg('getUpdates', { allowed_updates: ['message'] });
  const chats = new Map();
  for (const u of updates) { const m = u.message; if (m && m.chat && m.chat.type === 'private') chats.set(m.chat.id, m.text || ''); }
  let ids = [...chats.keys()];
  if (ids.length > 1) ids = ids.filter(id => /woodline/i.test(chats.get(id)));
  if (ids.length !== 1) {
    console.error(chats.size === 0
      ? 'Боту никто не писал за последние сутки. Откройте бота в Telegram, нажмите Start, напишите что-нибудь и запустите setup ещё раз.'
      : 'Боту писали несколько человек. Отправьте боту слово «woodline» со своего аккаунта и запустите setup ещё раз.');
    process.exit(1);
  }
  await cfgRef.set({ chatIds: ids, updatedAt: Date.now() }, { merge: true });
  await tg('sendMessage', { chat_id: ids[0], text: 'Готово! Каждое утро в 9:00 я буду присылать сюда сводку по заказам Woodline, а по понедельникам — копию всех заказов.' });
  console.log('Чат для отчётов сохранён.');
}

async function loadOrders() {
  const snap = await db.collection('orders').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function loadNotes() {
  try { const snap = await db.collection('notes').get(); return snap.docs.map(d => ({ id: d.id, ...d.data() })); }
  catch (e) { console.error('Заметки не прочитались:', e.message); return []; }
}
async function chatIds() {
  const c = (await cfgRef.get()).data();
  if (!c || !Array.isArray(c.chatIds) || !c.chatIds.length) { console.error('Чат не настроен: запустите workflow с режимом setup.'); process.exit(1); }
  return c.chatIds;
}

async function daily(withBackup) {
  const ids = await chatIds();
  const orders = await loadOrders();
  const notes = await loadNotes();
  const today = todayISO();
  const text = buildDaily(orders, { today, appUrl: APP_URL, notes });
  for (const id of ids) await tg('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true });

  const old = expiredTrash(orders);
  for (const id of old) await db.collection('orders').doc(id).delete();
  if (old.length) console.log(`Корзина: удалено навсегда ${old.length}.`);

  if (withBackup) {
    const csv = buildCSV(orders);
    const json = JSON.stringify({ exportedAt: new Date().toISOString(), orders, notes }, null, 1);
    for (const id of ids) {
      for (const [name, data, type, caption] of [
        [`zakazy-${today}.csv`, csv, 'text/csv', 'Копия заказов на ' + today + ' (открывается в Excel)'],
        [`backup-${today}.json`, json, 'application/json', 'Полная резервная копия: заказы (с корзиной и историей) и заметки'],
      ]) {
        const f = new FormData();
        f.append('chat_id', String(id));
        f.append('caption', caption);
        f.append('document', new Blob([data], { type }), name);
        await tg('sendDocument', f);
      }
    }
  }
  console.log(`Отчёт отправлен (${orders.length} документов в базе).`);
}

if (MODE === 'setup') await setup();
else await daily(MODE === 'weekly');

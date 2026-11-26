// Pure helpers for the Telegram reports: no network, no Firebase. Tested on their own.
export const TZ = 'Asia/Tashkent';
export const TRASH_DAYS = 20;
const CLOSED = new Set(['Доставлен', 'Отменён', 'Возврат']);
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
export const money = n => nf.format(Math.round(Number(n) || 0)).replace(/ | /g, ' ');
const num = v => Number(v) || 0;
export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Today's date in Tashkent as YYYY-MM-DD. */
export function todayISO(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
const dayNum = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
export function daysLeft(iso, today) { return /^\d{4}-\d\d-\d\d$/.test(iso || '') ? Math.round(dayNum(iso) - dayNum(today)) : null; }
function humanDate(iso) { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MON[m - 1]}, ${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`; }
function plural(n, a, b, c) { n = Math.abs(n); const x = n % 10, y = n % 100; if (x === 1 && y !== 11) return a; if (x >= 2 && x <= 4 && (y < 10 || y >= 20)) return b; return c; }

const chOf = o => (o.channel === 'uzum' ? 'uzum' : 'site');
const total = o => (chOf(o) === 'uzum' ? num(o.amount) : num(o.total));
const remaining = o => (chOf(o) === 'site' ? Math.max(0, num(o.remaining)) : 0);
function product(o) {
  if (Array.isArray(o.items) && o.items.length) return o.items.filter(i => i.name).map(i => i.name + (num(i.qty) > 1 ? ' ×' + num(i.qty) : '')).join(', ');
  return o.product || '';
}
function line(o, extra) {
  const who = chOf(o) === 'uzum' ? `Узум № ${esc(o.uzumId || '—')}` : esc(o.client || 'Без имени');
  const what = product(o);
  const due = remaining(o) > 0 && o.status !== 'Отменён' ? ` · получить <b>${money(remaining(o))}</b>` : '';
  return `• ${who}${what ? ' — ' + esc(what) : ''}${due}${extra ? ' · ' + extra : ''} <i>(${esc(o.status || 'Новый')})</i>`;
}
function listBlock(title, arr, extra, max = 12) {
  if (!arr.length) return '';
  const rows = arr.slice(0, max).map(o => line(o, extra && extra(o)));
  if (arr.length > max) rows.push(`…и ещё ${arr.length - max}`);
  return `<b>${title}: ${arr.length}</b>\n${rows.join('\n')}`;
}

/** Morning summary as Telegram HTML. */
export function buildDaily(orders, { today, appUrl }) {
  const live = orders.filter(o => !o.deletedAt);
  const act = live.filter(o => !CLOSED.has(o.status));
  const dl = o => daysLeft(o.date, today);
  const late = act.filter(o => dl(o) != null && dl(o) < 0).sort((a, b) => dl(a) - dl(b));
  const tod = act.filter(o => dl(o) === 0);
  const tom = act.filter(o => dl(o) === 1);
  const week = act.filter(o => dl(o) >= 2 && dl(o) <= 7).sort((a, b) => dl(a) - dl(b));
  const debtors = live.filter(o => chOf(o) === 'site' && o.status !== 'Отменён' && remaining(o) > 0);
  const debt = debtors.reduce((s, o) => s + remaining(o), 0);
  const collectToday = tod.reduce((s, o) => s + remaining(o), 0);

  const parts = [`<b>Woodline · сводка на ${humanDate(today)}</b>`];
  if (!tod.length && !late.length && !tom.length) parts.push('На сегодня и завтра доставок нет, просроченных заказов нет.');
  const t = listBlock('Сегодня доставить', tod);
  if (t) parts.push(t + (collectToday ? `\nПолучить с клиентов: <b>${money(collectToday)} сум</b>` : ''));
  const l = listBlock('Просрочено', late, o => `на ${-dl(o)} ${plural(dl(o), 'день', 'дня', 'дней')}`);
  if (l) parts.push(l);
  const m = listBlock('Завтра', tom);
  if (m) parts.push(m);
  if (week.length) parts.push(`<b>Дальше на неделе:</b> ${week.length} ${plural(week.length, 'заказ', 'заказа', 'заказов')}`);
  if (debt) parts.push(`<b>Долг клиентов:</b> ${money(debt)} сум (${debtors.length} ${plural(debtors.length, 'заказ', 'заказа', 'заказов')})`);
  if (appUrl) parts.push(`<a href="${esc(appUrl)}">Открыть приложение</a>`);
  return parts.join('\n\n');
}

/** All live orders as a CSV that Excel opens with Cyrillic intact. */
export function buildCSV(orders) {
  const head = ['Канал', '№ заказа Узум', 'ID сделки', 'ID заказа', 'Клиент', 'Телефон', 'Доп. телефон', 'Адрес', 'Товары', 'Сумма', 'Остаток', 'Расходы', 'Дата доставки', 'Статус', 'Заметка', 'Создан'];
  const q = v => { const s = v == null ? '' : String(v); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const d = ts => (ts ? new Date(ts).toLocaleString('ru-RU', { timeZone: TZ }) : '');
  const rows = orders.filter(o => !o.deletedAt).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(o => [
    chOf(o) === 'uzum' ? 'Узум' : 'Сайт', o.uzumId, o.dealId, o.orderId, o.client, o.phone, o.phone2, o.address, product(o),
    total(o) || '', chOf(o) === 'site' ? remaining(o) : '', num(o.expenses) || '', o.date, o.status, o.note, d(o.createdAt),
  ].map(q).join(';'));
  return '﻿' + head.join(';') + '\r\n' + rows.join('\r\n');
}

/** Ids of trash entries older than TRASH_DAYS. */
export function expiredTrash(orders, now = Date.now()) {
  const lim = now - TRASH_DAYS * 864e5;
  return orders.filter(o => o.deletedAt && o.deletedAt < lim).map(o => o.id);
}

'use strict';
/* Kharcha: every expense is written to this device first, then synced. */

const DEFAULTS = {
  categories: ['Groceries', 'Household', 'Kids', 'Fuel & transport', 'Food out', 'Health', 'Bills', 'Other'],
  methods: ['UPI', 'Cash', 'Card'],
};
const TIMEOUT_MS = 45000;
const RETRY_MS = 30000;
const POLL_MS = 120000;
const BATCH = 200;
const CODE_PREFIX = 'KH1.';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ---------- Storage ---------- */

const db = {
  handle: null,
  open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('kharcha', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('entries', { keyPath: 'id' });
        r.result.createObjectStore('meta');
      };
      r.onsuccess = () => { this.handle = r.result; resolve(); };
      r.onerror = () => reject(r.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.handle.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  all() { return this.run('entries', 'readonly', (s) => s.getAll()); },
  put(e) { return this.run('entries', 'readwrite', (s) => s.put(e)); },
  get(id) { return this.run('entries', 'readonly', (s) => s.get(id)); },
  clearEntries() { return this.run('entries', 'readwrite', (s) => s.clear()); },
  getMeta(k) { return this.run('meta', 'readonly', (s) => s.get(k)); },
  setMeta(k, v) { return this.run('meta', 'readwrite', (s) => s.put(v, k)); },
  clearMeta() { return this.run('meta', 'readwrite', (s) => s.clear()); },
};

/* ---------- Formatting ---------- */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => '₹' + (Number.isInteger(n) ? inr : inr2).format(n);
const toPaise = (n) => Math.round(Number(n) * 100);
const fromPaise = (p) => p / 100;
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoMonth = (d = new Date()) => isoDay(d).slice(0, 7);
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

function dayLabel(s) {
  const today = isoDay();
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (s === today) return 'Today';
  if (s === isoDay(y)) return 'Yesterday';
  return parseDay(s).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}
function monthLabel(m) {
  const d = parseDay(m + '-01');
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}
function shiftMonth(m, by) {
  const d = parseDay(m + '-01');
  d.setMonth(d.getMonth() + by);
  return isoMonth(d);
}

/* ---------- State ---------- */

const state = {
  config: null,        // {url, key, person, deviceId}
  entries: [],         // all local entries, deleted included
  settings: DEFAULTS,
  people: [],
  amount: '',
  date: null,          // null means today
  via: 'UPI',
  month: isoMonth(),
  filter: 'all',
  view: 'add',
  sync: { busy: false, again: false, error: null, last: 0 },
};

const live = () => state.entries.filter((e) => !e.deleted);
const dirtyCount = () => state.entries.filter((e) => e.dirty).length;
const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'id-' + Date.now().toString(36) + '-' + Array.from(crypto.getRandomValues(new Uint32Array(3)), (v) => v.toString(36)).join(''));

async function reload() {
  state.entries = await db.all();
}

async function saveLocal(entry) {
  await db.put(entry);
  const i = state.entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) state.entries[i] = entry; else state.entries.push(entry);
}

/* ---------- Sync ---------- */

class SyncError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}

async function callBackend(url, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    // text/plain keeps this a "simple" request; Apps Script cannot answer a CORS preflight.
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctl.signal,
    });
  } catch (err) {
    throw new SyncError('network');
  } finally {
    clearTimeout(timer);
  }
  let data;
  try { data = await res.json(); } catch (err) { throw new SyncError('bad_reply'); }
  if (!data || !data.ok) throw new SyncError((data && data.error) || 'bad_reply', data && data.detail);
  return data;
}

const wire = ({ dirty, ...rest }) => rest;

function normaliseRow(r) {
  return {
    id: String(r.id), date: String(r.date), amount: Number(r.amount) || 0,
    category: String(r.category || 'Other'), via: String(r.via || ''), note: String(r.note || ''),
    person: String(r.person || ''), deleted: !!r.deleted,
    created: Number(r.created) || 0, updated: Number(r.updated) || 0, dirty: 0,
  };
}

async function applyReply(sent, reply) {
  const tx = [];
  for (const raw of reply.rows || []) {
    const row = normaliseRow(raw);
    const local = state.entries.find((e) => e.id === row.id);
    // A newer unsent edit on this device stays; everything else takes the Sheet's copy.
    if (local && local.dirty && local.updated > row.updated) continue;
    tx.push(saveLocal(row));
  }
  await Promise.all(tx);
  const rejected = new Set(reply.rejected || []);
  for (const s of sent) {
    const local = state.entries.find((e) => e.id === s.id);
    if (local && local.dirty && local.updated === s.updated && !rejected.has(s.id)) {
      await saveLocal({ ...local, dirty: 0 });
    }
  }
  await db.setMeta('cursor', reply.rev);
  if (reply.settings) {
    const next = {
      categories: reply.settings.categories && reply.settings.categories.length ? reply.settings.categories : DEFAULTS.categories,
      methods: reply.settings.methods && reply.settings.methods.length ? reply.settings.methods : DEFAULTS.methods,
    };
    state.settings = next;
    state.people = reply.settings.people || [];
    await db.setMeta('settings', next);
    await db.setMeta('people', state.people);
  }
}

async function syncNow() {
  if (!state.config) return;
  if (state.sync.busy) { state.sync.again = true; return; }
  state.sync.busy = true;
  state.sync.error = null;
  renderStatus();
  try {
    let more = true;
    while (more) {
      const dirty = state.entries.filter((e) => e.dirty);
      const sent = dirty.slice(0, BATCH).map(wire);
      const since = (await db.getMeta('cursor')) || 0;
      const reply = await callBackend(state.config.url, { key: state.config.key, op: 'sync', since, changes: sent });
      await applyReply(sent, reply);
      const rejected = new Set(reply.rejected || []);
      more = dirty.length > BATCH && sent.some((s) => !rejected.has(s.id));
    }
    state.sync.last = Date.now();
    await db.setMeta('lastSync', state.sync.last);
    clearTimeout(state.retryTimer);
  } catch (err) {
    state.sync.error = err.code || 'network';
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(syncNow, RETRY_MS);
  } finally {
    state.sync.busy = false;
    renderAll();
    if (state.sync.again) { state.sync.again = false; syncNow(); }
  }
}

function statusText() {
  const n = dirtyCount();
  const s = state.sync;
  if (s.busy) return n ? `Syncing ${n}` : 'Checking for updates';
  if (s.error === 'bad_key') return 'Secret key rejected';
  if (s.error === 'not_set_up') return 'Run setup in the Sheet';
  if (s.error && n) return `${n} saved here, waiting to sync`;
  if (s.error) return 'Offline';
  if (n) return `${n} waiting to sync`;
  return 'All synced';
}

function renderStatus() {
  const b = $('sync-status');
  b.textContent = statusText();
  b.classList.toggle('warn', !!state.sync.error || dirtyCount() > 0);
  $('set-waiting').textContent = String(dirtyCount());
  $('set-last').textContent = state.sync.last
    ? new Date(state.sync.last).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : 'Not yet';
}

/* ---------- Entry pad ---------- */

function amountValue() {
  const v = parseFloat(state.amount);
  return isFinite(v) ? v : 0;
}

function pressKey(k) {
  $('toast').hidden = true; // starting the next entry dismisses the last confirmation
  let a = state.amount;
  if (k === 'back') a = a.slice(0, -1);
  else if (k === '.') {
    if (a.includes('.')) return;
    a = (a || '0') + '.';
  } else {
    const [whole, dec] = a.split('.');
    if (dec !== undefined && dec.length >= 2) return;
    if (dec === undefined && whole.length >= 8) return;
    a = a === '0' ? k : a + k;
  }
  state.amount = a;
  renderPad();
}

function renderPad() {
  const a = state.amount;
  let shown = '0';
  if (a) {
    const [whole, dec] = a.split('.');
    shown = inr.format(Number(whole || 0)) + (dec !== undefined ? '.' + dec : '');
  }
  $('amount-digits').textContent = shown;
  const box = $('amount');
  box.classList.toggle('empty', !a);
  box.classList.toggle('long', shown.length > 9);
  const ready = amountValue() > 0;
  $('hint').textContent = ready ? 'Tap a category to save' : 'Enter the amount';
  document.querySelectorAll('#cats button').forEach((b) => { b.disabled = !ready; });
}

function renderCats() {
  const box = $('cats');
  box.replaceChildren(...state.settings.categories.map((c) => {
    const b = el('button', '', c);
    b.type = 'button';
    b.addEventListener('click', () => logExpense(c));
    return b;
  }));
  const via = $('via-chips');
  if (!state.settings.methods.includes(state.via)) state.via = state.settings.methods[0];
  via.replaceChildren(...state.settings.methods.map((m) => {
    const b = el('button', '', m);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(m === state.via));
    b.addEventListener('click', () => {
      state.via = m;
      db.setMeta('via', m);
      renderCats();
      renderPad();
    });
    return b;
  }));
  renderPad();
}

function renderDate() {
  const day = state.date || isoDay();
  $('entry-date').value = day;
  $('entry-date').max = isoDay();
  $('date-label').textContent = dayLabel(day);
  document.querySelector('.date-chip').classList.toggle('other', !!state.date);
}

async function logExpense(category) {
  const value = amountValue();
  if (!(value > 0)) return;
  const now = Date.now();
  const entry = {
    id: newId(),
    date: state.date || isoDay(),
    amount: value,
    category,
    via: state.via,
    note: '',
    person: state.config.person,
    deleted: false,
    created: now,
    updated: now,
    dirty: 1,
  };
  await saveLocal(entry);
  if (navigator.vibrate) navigator.vibrate(12);
  state.amount = '';
  renderAll();
  toast(`Saved ${money(value)} in ${category}`, {
    undo: () => removeEntry(entry.id, true),
    note: () => openEdit(entry.id, true),
  });
  syncNow();
}

async function removeEntry(id, quiet) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  await saveLocal({ ...e, deleted: true, updated: Math.max(Date.now(), e.updated + 1), dirty: 1 });
  renderAll();
  if (!quiet) {
    toast(`Deleted ${money(e.amount)} from ${e.category}`, { undo: () => restoreEntry(id) });
  } else {
    toast('Removed');
  }
  syncNow();
}

async function restoreEntry(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  await saveLocal({ ...e, deleted: false, updated: Math.max(Date.now(), e.updated + 1), dirty: 1 });
  renderAll();
  toast('Restored');
  syncNow();
}

/* ---------- Toast ---------- */

let toastTimer;
function toast(text, actions = {}) {
  $('toast-text').textContent = text;
  const set = (id, fn) => {
    const b = $(id);
    b.hidden = !fn;
    b.onclick = fn ? () => { $('toast').hidden = true; fn(); } : null;
  };
  set('toast-undo', actions.undo);
  set('toast-note', actions.note);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, actions.undo ? 6000 : 2500);
}

/* ---------- History ---------- */

function monthEntries(month) {
  return live().filter((e) => e.date.startsWith(month));
}

function peopleList() {
  const names = new Set(state.people);
  live().forEach((e) => { if (e.person) names.add(e.person); });
  return [...names];
}

function renderMonthNavs() {
  document.querySelectorAll('.month-label').forEach((n) => { n.textContent = monthLabel(state.month); });
  document.querySelectorAll('.month-next').forEach((b) => { b.disabled = state.month >= isoMonth(); });
}

function renderHistory() {
  const people = peopleList();
  const filter = $('person-filter');
  if (people.length > 1) {
    const chip = (value, label) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.filter === value));
      b.addEventListener('click', () => { state.filter = value; renderHistory(); });
      return b;
    };
    filter.replaceChildren(chip('all', 'Both'), ...people.map((p) => chip(p, p)));
  } else {
    filter.replaceChildren();
    state.filter = 'all';
  }

  const rows = monthEntries(state.month)
    .filter((e) => state.filter === 'all' || e.person === state.filter)
    .sort((a, b) => (b.date.localeCompare(a.date)) || (b.created - a.created));

  const list = $('history-list');
  if (!rows.length) {
    const box = el('div', 'empty-state', `No expenses in ${monthLabel(state.month)}.`);
    list.replaceChildren(box);
    return;
  }
  const out = [];
  let day = null;
  for (const e of rows) {
    if (e.date !== day) {
      day = e.date;
      const sum = rows.filter((x) => x.date === day).reduce((s, x) => s + toPaise(x.amount), 0);
      const head = el('div', 'day-head');
      head.append(el('span', '', dayLabel(day)), el('span', '', money(fromPaise(sum))));
      out.push(head);
    }
    const row = el('button', 'row');
    row.type = 'button';
    row.setAttribute('aria-label', `Edit ${money(e.amount)}, ${e.category}`);
    const main = el('span', 'row-main');
    main.append(el('span', 'row-cat', e.category));
    const bits = [e.note, e.person, e.via].filter(Boolean).join(', ');
    if (bits) main.append(el('span', 'row-sub', bits));
    const amt = el('span', 'row-amt', money(e.amount));
    if (e.dirty) amt.append(el('span', 'row-wait', 'Not synced yet'));
    row.append(main, amt);
    row.addEventListener('click', () => openEdit(e.id));
    out.push(row);
  }
  list.replaceChildren(...out);
}

/* ---------- Summary ---------- */

function renderSummary() {
  const rows = monthEntries(state.month);
  const total = rows.reduce((s, e) => s + toPaise(e.amount), 0);
  const prevMonth = shiftMonth(state.month, -1);
  const prev = monthEntries(prevMonth).reduce((s, e) => s + toPaise(e.amount), 0);
  const body = $('summary-body');
  if (!rows.length) {
    body.replaceChildren(el('div', 'empty-state', `No expenses in ${monthLabel(state.month)}.`));
    return;
  }
  const head = el('div', 'total-line');
  head.append(el('span', 'total-num', money(fromPaise(total))));
  if (prev) {
    const diff = total - prev;
    const name = parseDay(prevMonth + '-01').toLocaleDateString('en-IN', { month: 'long' });
    const text = diff === 0 ? `Same as ${name}`
      : `${money(fromPaise(Math.abs(diff)))} ${diff > 0 ? 'more' : 'less'} than ${name}`;
    head.append(el('span', 'total-sub', text));
  }
  const nodes = [head];

  const perPerson = new Map();
  rows.forEach((e) => {
    const k = e.person || 'Unnamed';
    perPerson.set(k, (perPerson.get(k) || 0) + toPaise(e.amount));
  });
  if (perPerson.size > 1) {
    const dl = el('dl', 'people');
    [...perPerson.entries()].sort((a, b) => b[1] - a[1]).forEach(([name, p]) => {
      const d = el('div');
      d.append(el('dt', '', name), el('dd', '', money(fromPaise(p))));
      dl.append(d);
    });
    nodes.push(dl);
  }

  const perCat = new Map();
  rows.forEach((e) => perCat.set(e.category, (perCat.get(e.category) || 0) + toPaise(e.amount)));
  const sorted = [...perCat.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0][1];
  const ul = el('ul', 'bars');
  sorted.forEach(([name, p]) => {
    const li = el('li');
    const label = el('span', 'bar-label');
    label.append(el('span', 'bar-name', name), el('span', '', money(fromPaise(p))));
    const track = el('span', 'bar-track');
    const fill = el('span', 'bar-fill');
    fill.style.width = `${(p / top) * 100}%`;
    track.append(fill);
    li.append(label, track);
    ul.append(li);
  });
  nodes.push(ul);
  body.replaceChildren(...nodes);
}

/* ---------- Edit dialog ---------- */

let editingId = null;

function fillSelect(select, values, current) {
  const list = current && !values.includes(current) ? [...values, current] : values;
  select.replaceChildren(...list.map((v) => {
    const o = el('option', '', v);
    o.value = v;
    return o;
  }));
  select.value = current || list[0];
}

function openEdit(id, focusNote) {
  const e = state.entries.find((x) => x.id === id);
  if (!e || e.deleted) return;
  editingId = id;
  $('edit-amount').value = String(e.amount);
  fillSelect($('edit-category'), state.settings.categories, e.category);
  fillSelect($('edit-via'), state.settings.methods, e.via);
  $('edit-date').value = e.date;
  $('edit-date').max = isoDay();
  $('edit-note').value = e.note;
  $('edit-by').textContent = e.person ? `Logged by ${e.person}` : '';
  $('edit-error').hidden = true;
  $('edit').showModal();
  if (focusNote) $('edit-note').focus();
}

async function submitEdit(ev) {
  ev.preventDefault();
  const e = state.entries.find((x) => x.id === editingId);
  if (!e) { $('edit').close(); return; }
  const amount = Math.round(parseFloat($('edit-amount').value.replace(/[,₹\s]/g, '')) * 100) / 100;
  const date = $('edit-date').value;
  if (!(amount > 0)) return showEditError('Enter an amount above zero.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showEditError('Choose a date.');
  const next = {
    ...e,
    amount, date,
    category: $('edit-category').value,
    via: $('edit-via').value,
    note: $('edit-note').value.trim(),
    updated: Math.max(Date.now(), e.updated + 1),
    dirty: 1,
  };
  await saveLocal(next);
  $('edit').close();
  renderAll();
  toast('Changes saved');
  syncNow();
}

function showEditError(msg) {
  $('edit-error').textContent = msg;
  $('edit-error').hidden = false;
}

/* ---------- Rendering and navigation ---------- */

function renderToday() {
  const today = isoDay();
  const sum = live().filter((e) => e.date === today).reduce((s, e) => s + toPaise(e.amount), 0);
  $('today-total').textContent = money(fromPaise(sum));
}

function renderAll() {
  renderToday();
  renderMonthNavs();
  renderHistory();
  renderSummary();
  renderStatus();
  renderCats();
  renderDate();
  if (state.config) $('set-name').textContent = state.config.person;
}

function go(view) {
  state.view = view;
  document.body.dataset.view = view;
  document.querySelectorAll('[data-go]').forEach((b) => {
    if (b.dataset.go === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

/* ---------- Setup ---------- */

function encodeCode(url, key) {
  const raw = JSON.stringify({ u: url, k: key });
  return CODE_PREFIX + btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeCode(code) {
  const c = code.trim();
  if (!c.startsWith(CODE_PREFIX)) return null;
  try {
    const b = c.slice(CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(atob(b));
    return o.u && o.k ? { url: o.u, key: o.k } : null;
  } catch (err) { return null; }
}
function validUrl(u) {
  try {
    const x = new URL(u);
    const local = x.hostname === 'localhost' || x.hostname === '127.0.0.1';
    return (x.protocol === 'https:' || local) && x.pathname.endsWith('/exec');
  } catch (err) { return false; }
}

function setupMode(manual) {
  $('mode-code').setAttribute('aria-pressed', String(!manual));
  $('mode-manual').setAttribute('aria-pressed', String(manual));
  $('field-code').hidden = manual;
  $('field-url').hidden = !manual;
  $('field-key').hidden = !manual;
}

function setupError(msg) {
  $('setup-error').textContent = msg;
  $('setup-error').hidden = !msg;
}

const SETUP_MESSAGES = {
  bad_key: 'The Sheet rejected that secret key. Copy it again from the Apps Script log.',
  not_set_up: 'The Sheet is not ready. Run the setup function in Apps Script, then try again.',
  network: 'Could not reach your Sheet. Check the internet connection, and check that the web app is deployed with access set to Anyone.',
  bad_reply: 'That address did not answer like Kharcha. Use the Web app URL ending in /exec, with access set to Anyone.',
  server_error: 'Your Sheet reported an error. Run the setup function in Apps Script, then try again.',
};

async function submitSetup(ev) {
  ev.preventDefault();
  setupError('');
  const manual = $('mode-manual').getAttribute('aria-pressed') === 'true';
  let conn;
  if (manual) {
    conn = { url: $('setup-url').value.trim(), key: $('setup-key').value.trim() };
    if (!validUrl(conn.url)) return setupError('Enter the Web app URL. It starts with https:// and ends in /exec.');
    if (!conn.key) return setupError('Enter the secret key from the Apps Script log.');
  } else {
    conn = decodeCode($('setup-code').value);
    if (!conn || !validUrl(conn.url)) return setupError('That setup code is not valid. Copy it again from Settings on your other device.');
  }
  const person = $('setup-name').value.trim();
  if (!person) return setupError('Enter your name, so that you can both see who logged what.');

  const go1 = $('setup-go');
  go1.disabled = true;
  go1.textContent = 'Connecting';
  try {
    const reply = await callBackend(conn.url, { key: conn.key, op: 'sync', since: 0, changes: [] });
    const config = { ...conn, person, deviceId: newId() };
    await db.setMeta('config', config);
    state.config = config;
    await applyReply([], reply);
    await reload();
    state.sync.last = Date.now();
    await db.setMeta('lastSync', state.sync.last);
    enterApp();
  } catch (err) {
    setupError(SETUP_MESSAGES[err.code] || SETUP_MESSAGES.server_error);
  } finally {
    go1.disabled = false;
    go1.textContent = 'Connect';
  }
}

function enterApp() {
  $('setup').hidden = true;
  $('app').hidden = false;
  go(state.view);
  renderAll();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  syncNow();
}

/* ---------- Wiring ---------- */

function wire_() {
  document.querySelector('.keys').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b) pressKey(b.dataset.key);
  });
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  document.querySelectorAll('.month-prev').forEach((b) => b.addEventListener('click', () => { state.month = shiftMonth(state.month, -1); renderAll(); }));
  document.querySelectorAll('.month-next').forEach((b) => b.addEventListener('click', () => { state.month = shiftMonth(state.month, 1); renderAll(); }));

  $('sync-status').addEventListener('click', syncNow);
  $('btn-sync').addEventListener('click', syncNow);
  $('entry-date').addEventListener('change', (ev) => {
    const v = ev.target.value;
    state.date = v && v !== isoDay() ? v : null;
    renderDate();
  });

  $('edit-form').addEventListener('submit', submitEdit);
  $('edit-cancel').addEventListener('click', () => $('edit').close());
  $('edit-delete').addEventListener('click', () => {
    const id = editingId;
    $('edit').close();
    removeEntry(id);
  });

  $('mode-code').addEventListener('click', () => setupMode(false));
  $('mode-manual').addEventListener('click', () => setupMode(true));
  $('setup-form').addEventListener('submit', submitSetup);

  $('btn-code').addEventListener('click', async () => {
    const code = encodeCode(state.config.url, state.config.key);
    try { await navigator.clipboard.writeText(code); }
    catch (err) {
      $('code-note').textContent = code;
      $('code-note').hidden = false;
      return;
    }
    $('code-note').hidden = false;
  });

  $('btn-refresh').addEventListener('click', async () => {
    // Unsent entries stay. Everything else is fetched again from the Sheet.
    const keep = state.entries.filter((e) => e.dirty);
    await db.clearEntries();
    for (const e of keep) await db.put(e);
    await db.setMeta('cursor', 0);
    state.entries = keep;
    await syncNow();
    toast('Reloaded from the Sheet');
  });

  $('btn-disconnect').addEventListener('click', () => {
    const n = dirtyCount();
    $('confirm-text').textContent = n
      ? `${n} expenses on this device have not synced yet and will be lost. Your Google Sheet keeps everything else.`
      : 'Your expenses stay safe in the Google Sheet. You will need the setup code to reconnect.';
    $('confirm').showModal();
  });
  $('confirm-no').addEventListener('click', () => $('confirm').close());
  $('confirm-yes').addEventListener('click', async () => {
    await db.clearEntries();
    await db.clearMeta();
    location.reload();
  });

  // Physical keyboards on laptops and tablets
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target.closest('input, select, textarea, dialog') || $('app').hidden) return;
    if (/^[0-9.]$/.test(ev.key)) { pressKey(ev.key); ev.preventDefault(); }
    else if (ev.key === 'Backspace') { pressKey('back'); ev.preventDefault(); }
  });

  // Sync whenever the app comes back or the connection returns.
  window.addEventListener('online', syncNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      state.date = null;
      renderAll();
      syncNow();
    }
  });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, POLL_MS);
}

function readSetupLink() {
  const hash = location.hash.match(/^#setup=(.+)$/);
  if (!hash) return;
  if (!state.config) {
    setupMode(false);
    $('setup-code').value = decodeURIComponent(hash[1]);
  }
  // A setup code works like a password, so it does not stay in the address bar.
  history.replaceState(null, '', location.pathname);
}

async function start() {
  wire_();
  await db.open();
  const [config, settings, people, via, last] = await Promise.all(
    ['config', 'settings', 'people', 'via', 'lastSync'].map((k) => db.getMeta(k)));
  if (settings) state.settings = settings;
  if (people) state.people = people;
  if (via) state.via = via;
  if (last) state.sync.last = last;
  await reload();

  state.config = config || null;
  readSetupLink();
  window.addEventListener('hashchange', readSetupLink);

  document.body.classList.remove('booting');
  if (config) {
    enterApp();
  } else {
    $('setup').hidden = false;
    renderCats();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    let refreshed = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Pick up a new version, but never throw away an amount being typed.
      if (refreshed || !hadController || state.amount) return;
      refreshed = true;
      location.reload();
    });
  }
}

start().catch((err) => {
  document.body.classList.remove('booting');
  document.body.textContent = 'Kharcha could not open its storage on this device. Private browsing can block it, so try a normal window.';
  console.error(err);
});

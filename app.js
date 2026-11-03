'use strict';
/* Kharcha: every expense is written to this device first, then synced. */

const DEFAULTS = {
  categories: ['Groceries', 'Household', 'Kids', 'Fuel & transport', 'Food out', 'Health', 'Bills', 'Other'],
  officeCategories: ['Travel', 'Meals', 'Office supplies', 'Software', 'Internet & phone', 'Courier', 'Client', 'Other'],
  methods: ['UPI', 'Cash', 'Card'],
};
const BOOKS = ['Home', 'Office'];
const REQUIRED_FIELDS = { invoice: 'invoice', receipt: 'receipt no.', via: 'payment method', date: 'date', name: 'item name' };
const REQUIRED_LABELS = { invoice: 'Invoice or photo', receipt: 'Receipt or reference no.', via: 'Payment method', date: 'Date', name: 'Item name' };
const REQUIRED_DEFAULTS = { Home: ['via', 'date'], Office: ['invoice', 'receipt', 'via', 'date', 'name'] };
const PAY_TYPES = ['UPI', 'Credit card', 'RuPay on UPI', 'Debit card', 'Cash', 'Bank transfer', 'Cheque', 'Wallet', 'Other'];
const PAY_SHORT = { 'Credit card': 'Credit', 'Debit card': 'Debit', 'Bank transfer': 'Transfer' };
const PAY_EXAMPLES = {
  UPI: 'For example, GPay or PhonePe',
  'Credit card': 'For example, HDFC Millennia 1234',
  'RuPay on UPI': 'For example, HDFC RuPay 1234 on GPay',
  'Debit card': 'For example, SBI debit 5678',
  Cash: 'For example, Cash or Petty cash',
  'Bank transfer': 'For example, HDFC current 1234 (NEFT, IMPS, RTGS)',
  Cheque: 'For example, HDFC cheque book 1234',
  Wallet: 'For example, Paytm wallet',
};
const profileDb = (id) => (id === 'default' ? 'kharcha' : 'kharcha-' + id);
const seenKey = () => (state.profileId === 'default' ? 'kharcha-last-seen' : 'kharcha-last-seen-' + state.profileId);
const LONG_NUMBER = /(\d[\s-]?){9,}/; // looks like a card or account number
const TIMEOUT_MS = 45000;
const RETRY_MS = 30000;
const POLL_MS = 120000;
const BATCH = 200;
const CODE_PREFIX = 'KH1.';
const IDLE_MS = 5 * 60 * 1000;     // locks after 5 minutes out of use
const PIN_LENGTH = 4;
const PIN_ROUNDS = 150000;
const PIN_FREE_TRIES = 5;
const UPLOAD_TIMEOUT_MS = 180000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const PHOTO_MAX_SIDE = 1600;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ---------- Storage ---------- */

// Which accounts are on this device. Each account has its own database below.
const device = {
  handle: null,
  open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('kharcha-device', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.handle = r.result; resolve(); };
      r.onerror = () => reject(r.error);
    });
  },
  get(k) {
    return new Promise((resolve, reject) => {
      const q = this.handle.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  },
  set(k, v) {
    return new Promise((resolve, reject) => {
      const tx = this.handle.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  remove(name) {
    return new Promise((resolve) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  },
};

const db = {
  handle: null,
  open(name = 'kharcha') {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
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
  delMeta(k) { return this.run('meta', 'readwrite', (s) => s.delete(k)); },
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
  profileId: 'default',
  profiles: [],        // accounts connected on this device
  payDefaults: {},     // the default payment method for each type
  config: null,        // {url, key, person, deviceId}
  entries: [],         // all local entries, deleted included
  fileQueue: [],       // files waiting to upload (details only; the file is stored separately)
  settings: DEFAULTS,
  people: [],
  amount: '',
  date: null,          // null means today
  viaByBook: {},       // the last payment method used in each book
  lists: [],           // categories, subcategories, labels, payment methods
  needs: null,         // Expenses filter: null, 'all', or one required field
  draftFiles: [],      // files chosen on the pad before the expense is saved
  cart: [],            // items on the pad: {name, category, sub, price}
  target: null,        // which cart line the keypad fills; null means the total
  padCat: { category: 'Other', sub: '' }, // category when there are no items
  book: 'Home',
  month: isoMonth(),
  filter: 'all',
  view: 'add',
  sync: { busy: false, again: false, error: null, last: 0 },
};

const live = () => state.entries.filter((e) => !e.deleted);
const isStaff = () => !!(state.config && state.config.role === 'staff');
const bookOf = (e) => e.book || 'Home';
const inBook = () => live().filter((e) => bookOf(e) === state.book);
const byAge = (a, b) => (a.created - b.created) || a.name.localeCompare(b.name);
const liveList = (kind) => state.lists.filter((l) => l.kind === kind && !l.deleted).sort(byAge);
const catObjs = (book) => liveList('category').filter((l) => l.book === book);
const catsFor = (book) => {
  const list = catObjs(book).map((l) => l.name);
  return list.length ? list : (book === 'Office' ? DEFAULTS.officeCategories : DEFAULTS.categories);
};
const subsFor = (book, categoryName) => {
  const cat = catObjs(book).find((l) => l.name === categoryName);
  return cat ? liveList('subcategory').filter((l) => l.parent === cat.id).map((l) => l.name) : [];
};
const instruments = () => {
  const list = liveList('instrument');
  if (list.length || state.lists.some((l) => l.kind === 'instrument')) return list;
  return DEFAULTS.methods.map((name) => ({ id: 'default-' + name, name, type: name, linked: '', owner: '' }));
};
const minePay = () => {
  const me = state.config ? state.config.person : '';
  const list = instruments().filter((i) => !i.owner || i.owner === me || i.owner === 'Office');
  return list.length ? list : instruments();
};
const defaultFor = (type) => {
  const items = minePay().filter((i) => i.type === type);
  return items.find((i) => i.id === state.payDefaults[type]) || items[0];
};
// May be undefined when every payment method has been deleted.
const currentVia = () => {
  const id = state.viaByBook[state.book];
  const chosen = instruments().find((i) => i.id === id);
  if (chosen) return chosen;
  const groups = groupByType(minePay());
  return groups.length ? defaultFor(groups[0][0]) : undefined;
};
const payLine = (i) => [i.type !== i.name ? i.type : '', i.linked, i.owner].filter(Boolean).join(', ');
function groupByType(list) {
  const order = [...PAY_TYPES];
  list.forEach((i) => { if (!order.includes(i.type)) order.push(i.type); });
  return order.map((type) => [type, list.filter((i) => i.type === type)]).filter(([, items]) => items.length);
}
async function putList(item) {
  const i = state.lists.findIndex((l) => l.id === item.id);
  if (i >= 0) state.lists[i] = item; else state.lists.push(item);
  await db.setMeta('lists', state.lists);
}
const dirtyCount = () => state.entries.filter((e) => e.dirty).length + state.fileQueue.length
  + state.lists.filter((l) => l.dirty).length;
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

async function callBackend(url, body, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
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

const wire = ({ dirty, files, ...rest }) => rest;

function normaliseRow(r) {
  return {
    id: String(r.id), date: String(r.date), amount: Number(r.amount) || 0,
    category: String(r.category || 'Other'), via: String(r.via || ''), note: String(r.note || ''),
    person: String(r.person || ''), book: String(r.book || 'Home'),
    item: String(r.item || ''), receipt: String(r.receipt || ''),
    orderId: String(r.orderId || ''), subcategory: String(r.subcategory || ''), labels: Array.isArray(r.labels) ? r.labels : [],
    viaType: String(r.viaType || ''), viaLinked: String(r.viaLinked || ''),
    files: Array.isArray(r.files) ? r.files : [], deleted: !!r.deleted,
    created: Number(r.created) || 0, updated: Number(r.updated) || 0, dirty: 0,
  };
}

async function applyLists(sentLists, reply) {
  for (const row of reply.listRows || []) {
    const local = state.lists.find((l) => l.id === row.id);
    if (local && local.dirty && local.updated > row.updated) continue;
    const item = { ...row, dirty: 0 };
    const i = state.lists.findIndex((l) => l.id === row.id);
    if (i >= 0) state.lists[i] = item; else state.lists.push(item);
  }
  const rejected = new Set(reply.listRejected || []);
  state.lists = state.lists.filter((l) => !rejected.has(l.id));
  for (const s of sentLists) {
    const local = state.lists.find((l) => l.id === s.id);
    if (local && local.dirty && local.updated === s.updated) local.dirty = 0;
  }
  await db.setMeta('lists', state.lists);
  if (reply.listRev !== undefined) await db.setMeta('listCursor', reply.listRev);
}

/* ---------- Several accounts on one device ---------- */

async function rememberProfile() {
  if (!state.config) return;
  const entry = { id: state.profileId, name: state.config.person, role: state.config.role || 'full' };
  const i = state.profiles.findIndex((p) => p.id === entry.id);
  if (i >= 0 && JSON.stringify(state.profiles[i]) === JSON.stringify(entry)) return;
  if (i >= 0) state.profiles[i] = entry; else state.profiles.push(entry);
  await device.set('profiles', state.profiles);
}

async function leaveTo(id) {
  // Next time, the account being left asks for its PIN.
  state.leaving = true;
  try { localStorage.removeItem(seenKey()); } catch (err) { /* it will simply ask */ }
  await device.set('active', id);
  location.reload();
}

async function switchProfile(id) {
  if (id === state.profileId) { $('accounts').close(); return; }
  await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 3000))]);
  await leaveTo(id);
}

function openAccounts() {
  $('accounts-list').replaceChildren(...state.profiles.map((p) => {
    const b = el('button', 'via-option', p.name);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(p.id === state.profileId));
    b.append(el('small', '', [p.role === 'staff' ? 'Office staff' : 'Full access', p.id === state.profileId ? 'Open now' : ''].filter(Boolean).join(', ')));
    b.addEventListener('click', () => switchProfile(p.id));
    return b;
  }));
  $('accounts').showModal();
}

async function addProfile() {
  const id = 'p' + newId().replace(/[^a-z0-9]/gi, '').slice(0, 12);
  await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 3000))]);
  await leaveTo(id);
}

// Closes this account on this device. Other accounts keep their data.
async function dropProfile() {
  await db.clearEntries();
  await db.clearMeta();
  try { localStorage.removeItem(seenKey()); } catch (err) { /* nothing to remove */ }
  const rest = state.profiles.filter((p) => p.id !== state.profileId);
  await device.set('profiles', rest);
  if (state.profileId !== 'default') {
    db.handle.close();
    await device.remove(profileDb(state.profileId));
  }
  await device.set('active', rest.length ? rest[0].id : 'default');
  location.reload();
}

async function applyMe(me) {
  if (!me || !state.config) return;
  const next = { ...state.config, role: me.role, person: me.name || state.config.person };
  if (next.role !== state.config.role || next.person !== state.config.person) {
    state.config = next;
    await db.setMeta('config', next);
  }
  await rememberProfile();
}

async function applyReply(sent, reply, sentLists = []) {
  await applyMe(reply.me);
  await applyLists(sentLists, reply);
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
      officeCategories: reply.settings.officeCategories && reply.settings.officeCategories.length ? reply.settings.officeCategories : DEFAULTS.officeCategories,
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
      const sentLists = state.lists.filter((l) => l.dirty).map(({ dirty, ...rest }) => rest);
      const listSince = (await db.getMeta('listCursor')) || 0;
      const reply = await callBackend(state.config.url, {
        key: state.config.key, op: 'sync', since, changes: sent, listSince, listChanges: sentLists,
      });
      await applyReply(sent, reply, sentLists);
      const rejected = new Set(reply.rejected || []);
      more = dirty.length > BATCH && sent.some((s) => !rejected.has(s.id));
    }
    await uploadPending();
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

/* ---------- Files ---------- */

const backendCall = (body, timeout) => callBackend(state.config.url, { key: state.config.key, ...body }, timeout);

async function setServerFiles(entryId, files) {
  const e = state.entries.find((x) => x.id === entryId);
  if (e) await saveLocal({ ...e, files });
}

async function dropQueued(id) {
  state.fileQueue = state.fileQueue.filter((f) => f.id !== id);
  await db.setMeta('fileQueue', state.fileQueue);
  await db.delMeta('file:' + id);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function uploadPending() {
  for (const f of [...state.fileQueue]) {
    const entry = state.entries.find((e) => e.id === f.entryId);
    if (entry && entry.dirty) continue; // its expense goes first
    const blob = await db.getMeta('file:' + f.id);
    if (!blob) { await dropQueued(f.id); continue; }
    try {
      const reply = await backendCall({
        op: 'upload', entryId: f.entryId, file: { id: f.id, name: f.name, type: f.type }, data: await blobToBase64(blob),
      }, UPLOAD_TIMEOUT_MS);
      await setServerFiles(f.entryId, reply.files);
      await dropQueued(f.id);
    } catch (err) {
      if (err.code === 'no_entry') continue;
      if (err.code === 'bad_file' || err.code === 'too_many_files') {
        await dropQueued(f.id);
        toast(`Could not store ${f.name}. Files can be up to 10 MB, with up to 10 on each expense.`);
        continue;
      }
      throw err;
    }
    renderEditFiles();
  }
}

// Photos from a phone can be several MB; this keeps them readable but small.
async function shrinkPhoto(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || !window.createImageBitmap) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 500 * 1024) { bmp.close(); return file; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // PNG transparency would otherwise turn black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
    if (!out || out.size >= file.size) return file;
    return new File([out], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch (err) {
    return file; // an unreadable format is still uploaded as it is
  }
}

async function prepareFiles(fileList, already) {
  const files = [];
  const problems = [];
  for (const original of fileList) {
    if (already + files.length >= MAX_FILES) { problems.push('An expense can have up to 10 files.'); break; }
    const file = await shrinkPhoto(original);
    if (file.size > MAX_FILE_BYTES) { problems.push(`${original.name} is larger than 10 MB.`); continue; }
    if (!file.size) { problems.push(`${original.name} is empty.`); continue; }
    files.push(file);
  }
  return { files, problems };
}

async function queueFile(entryId, file) {
  const item = { id: newId(), entryId, name: file.name || 'file', type: file.type || 'application/octet-stream', size: file.size };
  await db.setMeta('file:' + item.id, new Blob([file], { type: item.type }));
  state.fileQueue.push(item);
  await db.setMeta('fileQueue', state.fileQueue);
}

async function attachFiles(fileList) {
  const e = state.entries.find((x) => x.id === editingId);
  if (!e) return;
  const already = (e.files || []).length + state.fileQueue.filter((f) => f.entryId === e.id).length;
  const { files, problems } = await prepareFiles(fileList, already);
  for (const file of files) await queueFile(e.id, file);
  $('edit-error').textContent = problems.join(' ');
  $('edit-error').hidden = !problems.length;
  renderEditFiles();
  renderAll();
  syncNow();
}

function renderEditFiles() {
  const box = $('edit-files');
  const e = state.entries.find((x) => x.id === editingId);
  if (!e || !$('edit').open) return;
  const line = (f, waiting) => {
    const li = el('li');
    const info = el('span', 'file-info', f.name);
    const size = f.size >= 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((f.size || 0) / 1024))} KB`;
    info.append(el('span', 'file-state', waiting ? `${size}, not uploaded yet` : size));
    const view = el('button', '', 'View');
    view.type = 'button';
    view.addEventListener('click', () => viewFile(e.id, f, waiting));
    const rm = el('button', 'remove', 'Remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove ${f.name}`);
    rm.addEventListener('click', () => removeFile(e.id, f, waiting));
    li.append(info, view, rm);
    return li;
  };
  box.replaceChildren(
    ...(e.files || []).map((f) => line(f, false)),
    ...state.fileQueue.filter((f) => f.entryId === e.id).map((f) => line(f, true)),
  );
}

async function removeFile(entryId, f, waiting) {
  $('edit-error').hidden = true;
  if (waiting) {
    await dropQueued(f.id);
  } else {
    try {
      const reply = await backendCall({ op: 'removeFile', entryId, fileId: f.id });
      await setServerFiles(entryId, reply.files);
    } catch (err) {
      showEditError('Removing an uploaded file needs an internet connection.');
      return;
    }
  }
  renderEditFiles();
  renderAll();
}

let viewerUrl = null;
function closeViewer() {
  if ($('viewer').open) $('viewer').close();
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = null;
  $('viewer-img').removeAttribute('src');
}

async function viewFile(entryId, f, waiting) {
  closeViewer();
  $('viewer-title').textContent = f.name;
  $('viewer-msg').textContent = 'Opening';
  $('viewer-img').hidden = true;
  $('viewer-save').hidden = true;
  $('viewer').showModal();
  let blob;
  try {
    if (waiting) {
      blob = await db.getMeta('file:' + f.id);
    } else {
      const reply = await backendCall({ op: 'download', entryId, fileId: f.id }, UPLOAD_TIMEOUT_MS);
      const bytes = Uint8Array.from(atob(reply.data), (c) => c.charCodeAt(0));
      blob = new Blob([bytes], { type: reply.type || f.type });
    }
    if (!blob) throw new Error('missing');
  } catch (err) {
    $('viewer-msg').textContent = err.code === 'network'
      ? 'Opening an uploaded file needs an internet connection.'
      : 'This file could not be opened. It may have been removed.';
    return;
  }
  if (!$('viewer').open) return;
  viewerUrl = URL.createObjectURL(blob);
  $('viewer-msg').textContent = '';
  if (/^image\//.test(f.type)) {
    $('viewer-img').alt = f.name;
    $('viewer-img').src = viewerUrl;
    $('viewer-img').hidden = false;
  }
  $('viewer-save').href = viewerUrl;
  $('viewer-save').download = f.name;
  $('viewer-save').hidden = false;
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

function renderToastSync() {
  const box = $('toast');
  if (!box.classList.contains('saved')) { $('toast-sync').textContent = ''; return; }
  $('toast-sync').textContent = !dirtyCount() ? 'Synced to your Sheet'
    : state.sync.error ? 'Saved on this device. It will sync when you are online.'
      : 'Saved on this device, syncing to your Sheet';
}

function renderStatus() {
  renderToastSync();
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
  closeResults($('pad-results'));
  const line = state.target === null ? null : state.cart[state.target];
  let a = line ? line.price : state.amount;
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
  if (line) line.price = a; else state.amount = a;
  renderPad();
  renderCartLines();
}

const showAmount = (text) => {
  if (!text) return '0';
  const [whole, dec] = text.split('.');
  return inr.format(Number(whole || 0)) + (dec !== undefined ? '.' + dec : '');
};

// Turns the screen's contents into the expenses to save, or says what is missing.
function buildRows() {
  const typed = cleanListName($('pad-name').value);
  const lines = [...state.cart];
  const priced = lines.filter((l) => parseFloat(l.price) > 0);
  const unpriced = lines.filter((l) => !(parseFloat(l.price) > 0));
  const sum = priced.reduce((t, l) => t + toPaise(l.price), 0);
  const entered = toPaise(amountValue());
  const total = entered || sum;
  const rows = priced.map((l) => ({ item: l.name, category: l.category, sub: l.sub, paise: toPaise(l.price), note: (l.note || '').trim() }));
  const rest = total - sum;
  if (!lines.length) {
    if (entered) rows.push({ item: typed, category: state.padCat.category, sub: state.padCat.sub, paise: entered });
    return { rows, total, problem: entered ? '' : 'Enter an amount' };
  }
  if (total && rest < 0) return { rows, total, problem: 'Total is less than the prices' };
  if (unpriced.length) {
    if (rest <= 0) return { rows, total, problem: lines.length > 1 ? 'Add prices or a total' : 'Enter a price' };
    const first = unpriced[0];
    rows.push({
      item: unpriced.map((l) => l.name).join(', '), category: first.category, sub: first.sub, paise: rest,
      note: unpriced.map((l) => (l.note || '').trim()).filter(Boolean).join(', ').slice(0, 300),
    });
  } else if (rest > 0) {
    rows.push({ item: 'Other charges', category: 'Other', sub: '', paise: rest }); // delivery, taxes, tips
  }
  return { rows, total, problem: total ? '' : 'Enter a price' };
}

function renderPad() {
  const line = state.target === null ? null : state.cart[state.target];
  const built = buildRows();
  const text = line ? line.price : (state.amount || (built.total && !state.amount ? String(fromPaise(built.total)) : ''));
  const shown = showAmount(text);
  $('amount-digits').textContent = shown;
  $('total-label').textContent = line ? `Price of ${line.name}` : (state.cart.length ? 'Total' : 'Amount');
  const box = $('amount');
  box.classList.toggle('empty', !text);
  box.classList.toggle('long', shown.length > 9);
  $('total-row').classList.toggle('active', !line);
  const save = $('save');
  save.disabled = !!built.problem;
  save.textContent = built.problem || `Save ${money(fromPaise(built.total))}`;
}

function renderCats() {
  renderViaChips();
  renderCartLines();
  renderPad();
}

function renderCartLines() {
  const box = $('cart');
  box.replaceChildren(...state.cart.map((line, i) => {
    const row = el('div', `line${state.target === i ? ' active' : ''}`);
    const name = el('button', 'line-name', line.name);
    name.type = 'button';
    name.setAttribute('aria-label', `${line.name}, ${line.category}. Change category`);
    name.append(el('small', '', [line.category, line.sub].filter(Boolean).join(', ')));
    name.addEventListener('click', () => openCatPicker((category, sub) => {
      line.category = category;
      line.sub = sub;
      renderCartLines();
    }));
    const price = el('button', `line-price${line.price ? '' : ' empty'}`, line.price ? `₹${showAmount(line.price)}` : 'Price');
    price.type = 'button';
    price.setAttribute('aria-label', `Set the price of ${line.name}`);
    price.addEventListener('click', () => { state.target = i; renderCartLines(); renderPad(); });
    const rm = el('button', 'line-remove', '×');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove ${line.name}`);
    rm.addEventListener('click', () => {
      state.cart.splice(i, 1);
      state.target = state.cart.length ? state.cart.length - 1 : null;
      renderCartLines();
      renderPad();
    });
    row.append(name, price, rm);
    if (line.note || line.noteOpen) {
      const note = el('input', 'line-note');
      note.type = 'text';
      note.maxLength = 300;
      note.value = line.note || '';
      note.placeholder = 'Note, for example Flat 302';
      note.setAttribute('aria-label', `Note for ${line.name}`);
      note.addEventListener('input', () => { line.note = note.value; });
      note.addEventListener('blur', () => {
        line.noteOpen = false;
        if (!(line.note || '').trim()) { line.note = ''; setTimeout(renderCartLines, 150); }
      });
      row.append(note);
    } else {
      const add = el('button', 'line-note-add', '+ Add note');
      add.type = 'button';
      add.setAttribute('aria-label', `Add a note to ${line.name}`);
      add.addEventListener('click', () => {
        line.noteOpen = true;
        renderCartLines();
        const box = $('cart').children[state.cart.indexOf(line)].querySelector('.line-note');
        if (box) box.focus();
      });
      row.append(add);
    }
    return row;
  }));
  const quick = $('cart-quick');
  const items = state.cart.length || !state.config ? [] : searchItems('', state.book).slice(0, 8);
  quick.replaceChildren(...items.map((item) => {
    const b = el('button', 'quick-item', item.name);
    b.type = 'button';
    b.addEventListener('click', () => pickDraftItem(item));
    return b;
  }));
  quick.hidden = !items.length;
}

function openCatPicker(onChoose) {
  const list = $('cat-list');
  const show = (category) => {
    const button = (text, sub, fn) => {
      const b = el('button', 'via-option', text);
      b.type = 'button';
      if (sub) b.append(el('small', '', sub));
      b.addEventListener('click', fn);
      return b;
    };
    const done = (c, s) => { $('cat-picker').close(); onChoose(c, s); renderPad(); };
    if (!category) {
      $('cat-title').textContent = 'Category';
      list.replaceChildren(...catsFor(state.book).map((c) => {
        const subs = subsFor(state.book, c);
        return button(c, subs.length ? `${subs.length} ${subs.length === 1 ? 'subcategory' : 'subcategories'}` : '',
          () => (subs.length ? show(c) : done(c, '')));
      }));
    } else {
      $('cat-title').textContent = category;
      list.replaceChildren(
        ...subsFor(state.book, category).map((s) => button(s, '', () => done(category, s))),
        button(`Just ${category}`, '', () => done(category, '')),
        button('Back', '', () => show(null)),
      );
    }
  };
  show(null);
  $('cat-picker').showModal();
}

// One button per payment type that has a method. A tap uses that type's default.
function renderViaChips() {
  const now = currentVia();
  $('via-chip').textContent = now ? now.name : 'Add one';
  $('via-cell').setAttribute('aria-label', now ? `Paid via ${now.name}. Change` : 'Add a payment method');
}

function renderBooks() {
  document.body.classList.toggle('staff', isStaff());
  if (isStaff()) state.book = 'Office';
  document.body.dataset.book = state.book;
  document.querySelectorAll('.book-switch').forEach((box) => {
    box.replaceChildren(...BOOKS.map((name) => {
      const b = el('button', '', name);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(name === state.book));
      b.addEventListener('click', () => {
        state.book = name;
        if (state.book !== name) {
          state.cart = [];
          state.target = null;
          state.padCat = { category: 'Other', sub: '' };
        }
        db.setMeta('book', name);
        renderAll();
      });
      return b;
    }));
  });
}

function renderDraft() {
  const box = $('pad-files');
  box.hidden = !state.draftFiles.length;
  $('attach-label').textContent = state.draftFiles.length ? `${state.draftFiles.length} added` : 'Add';
  $('attach-chip').classList.toggle('filled', state.draftFiles.length > 0);
  box.replaceChildren(...state.draftFiles.map((f, i) => {
    const b = el('button', 'pad-file');
    b.type = 'button';
    b.setAttribute('aria-label', `Remove ${f.name}`);
    b.append(el('span', '', f.name), document.createTextNode('×'));
    b.addEventListener('click', () => { state.draftFiles.splice(i, 1); renderDraft(); });
    return b;
  }));
}

function clearDraft() {
  state.draftFiles = [];
  state.cart = [];
  state.target = null;
  state.amount = '';
  state.padCat = { category: 'Other', sub: '' };
  $('pad-name').value = '';
  renderDraft();
  closeResults($('pad-results'));
}

async function addDraftFiles(fileList) {
  closeResults($('pad-results'));
  const { files, problems } = await prepareFiles(fileList, state.draftFiles.length);
  state.draftFiles.push(...files);
  renderDraft();
  if (problems.length) toast(problems.join(' '));
}

/* ---------- Item catalog and search ---------- */

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9&+\s]/g, ' ').replace(/\s+/g, ' ').trim();
let builtIn = null;

function catalogItems() {
  if (builtIn) return builtIn;
  builtIn = [];
  (typeof CATALOG === 'undefined' ? [] : CATALOG).forEach(([book, category, sub, text]) => {
    text.split('|').forEach((raw) => {
      const [name, ...aliases] = raw.split('/');
      builtIn.push({ name, book, category, sub, n: norm(name), a: aliases.map(norm), where: norm(`${category} ${sub}`) });
    });
  });
  return builtIn;
}

function itemsFor(book) {
  const added = liveList('item').filter((l) => l.book === book).map((l) => ({
    name: l.name, book, category: l.type, sub: l.linked, custom: true, n: norm(l.name), a: [], where: norm(`${l.type} ${l.linked}`),
  }));
  const taken = new Set(added.map((i) => i.n));
  return [...added, ...catalogItems().filter((i) => i.book === book && !taken.has(i.n))];
}

function itemUsage() {
  const counts = new Map();
  state.entries.forEach((e) => {
    if (e.deleted || !e.item) return;
    e.item.split(', ').forEach((name) => {
      const k = norm(name);
      counts.set(k, (counts.get(k) || 0) + 1);
    });
  });
  return counts;
}

function scoreItem(item, q, words) {
  let score = 0;
  if (item.n === q) score = 200;
  else if (item.n.startsWith(q)) score = 120;
  else if (item.a.some((a) => a === q)) score = 115;
  else if (item.a.some((a) => a.startsWith(q))) score = 100;
  else if (item.n.split(' ').some((w) => w.startsWith(q))) score = 90;
  else if (words.every((w) => item.n.split(' ').some((x) => x.startsWith(w)) || item.a.some((a) => a.split(' ').some((x) => x.startsWith(w))))) score = 75;
  else if (words.every((w) => item.n.includes(w) || item.a.some((a) => a.includes(w)))) score = 50;
  else if (words.every((w) => item.where.includes(w))) score = 25;
  return score;
}

// With nothing typed, this shows what you use most.
function searchItems(query, book, exclude = []) {
  const q = norm(query);
  const skip = new Set(exclude.map(norm));
  const usage = itemUsage();
  const all = itemsFor(book).filter((i) => !skip.has(i.n));
  if (!q) {
    return all.filter((i) => usage.has(i.n) || i.custom)
      .sort((a, b) => (usage.get(b.n) || 0) - (usage.get(a.n) || 0)).slice(0, 8);
  }
  const words = q.split(' ');
  return all.map((item) => {
    const base = scoreItem(item, q, words);
    return { item, score: base ? base + Math.min(30, (usage.get(item.n) || 0) * 6) + (item.custom ? 10 : 0) : 0 };
  }).filter((x) => x.score).sort((a, b) => (b.score - a.score) || (a.item.n.length - b.item.n.length)).slice(0, 25).map((x) => x.item);
}

function closeResults(box) {
  box.hidden = true;
  box.replaceChildren();
}

function showResults(box, query, book, opts) {
  const list = searchItems(query, book, opts.exclude);
  const nodes = [];
  if (opts.selected) {
    const head = el('div', 'result-head');
    head.append(el('span', '', `${opts.selected} selected`));
    const done = el('button', '', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => { opts.input.blur(); closeResults(box); });
    head.append(done);
    nodes.push(head);
  }
  list.forEach((item) => {
    const b = el('button', 'result', item.name);
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.append(el('small', '', [item.category, item.sub].filter(Boolean).join(', ') + (item.custom ? ', added by you' : '')));
    b.addEventListener('click', () => opts.onPick(item));
    nodes.push(b);
  });
  const typed = query.trim();
  if (typed && !list.some((i) => i.n === norm(typed)) && !(opts.exclude || []).some((n) => norm(n) === norm(typed))) {
    const b = el('button', 'result new', `Add "${typed}" as a new item`);
    b.type = 'button';
    b.append(el('small', '', 'Then choose its category and subcategory'));
    b.addEventListener('click', () => openItemEdit(typed, book, opts.onPick));
    nodes.push(b);
  }
  box.replaceChildren(...nodes);
  box.hidden = !nodes.length;
  box.scrollTop = 0;
  fitResults(box);
}

// Keeps every result reachable above the on-screen keyboard.
function fitResults(box) {
  if (box.hidden || box.id !== 'pad-results') return;
  const view = window.visualViewport;
  const bottom = view ? view.offsetTop + view.height : innerHeight;
  box.style.maxHeight = `${Math.max(110, Math.min(230, bottom - box.getBoundingClientRect().top - 8))}px`;
}

function wireItemSearch(input, box, getOpts) {
  const refresh = () => {
    const last = input.id === 'edit-item' ? input.value.split(',').pop() : input.value;
    showResults(box, last, getOpts().book, { ...getOpts(), input });
  };
  if (input.id === 'pad-name') input.addEventListener('focus', refresh);
  input.addEventListener('input', refresh);
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input && !$('item-edit').open) closeResults(box); }, 150));
  // Keep the keyboard open while tapping a result, so several can be chosen.
  box.addEventListener('mousedown', (ev) => ev.preventDefault());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { closeResults(box); return; }
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    if (input.value.trim()) {
      const first = box.querySelector('.result');
      if (first) first.click();
    }
  });
  return refresh;
}



function pickDraftItem(item) {
  if (!state.cart.some((l) => norm(l.name) === norm(item.name))) {
    state.cart.push({ name: item.name, category: item.category || 'Other', sub: item.sub || '', price: '' });
  }
  state.target = state.cart.length - 1; // the keypad now fills this item's price
  $('pad-name').value = '';
  renderCartLines();
  renderPad();
  if (document.activeElement === $('pad-name')) padRefresh();
  else closeResults($('pad-results'));
}

let padRefresh = () => {};
let editRefresh = () => {};

// Adds whichever category and subcategory a chosen item uses, so they appear for next time.
async function ensureLists(book, category, sub) {
  if (isStaff() || !category) return;
  let cat = catObjs(book).find((c) => c.name.toLowerCase() === category.toLowerCase());
  if (!cat) cat = await saveListItem({ kind: 'category', name: category, book });
  if (sub && !liveList('subcategory').some((s) => s.parent === cat.id && s.name.toLowerCase() === sub.toLowerCase())) {
    await saveListItem({ kind: 'subcategory', name: sub, book, parent: cat.id });
  }
}

const catalogCats = (book) => [...new Set(catalogItems().filter((i) => i.book === book).map((i) => i.category))];
const catalogSubs = (book, category) => [...new Set(catalogItems().filter((i) => i.book === book && i.category === category).map((i) => i.sub))];

let itemDraft = null;

function fillItemCats(book, current) {
  const names = [...new Set([...catsFor(book), ...catalogCats(book)])];
  const select = $('item-cat');
  const options = names.map((n) => { const o = el('option', '', n); o.value = n; return o; });
  const fresh = el('option', '', 'New category');
  fresh.value = '__new';
  select.replaceChildren(...options, fresh);
  select.value = current && names.includes(current) ? current : names[0];
  fillItemSubs(book);
}

function fillItemSubs(book, current = '') {
  const category = $('item-cat').value;
  const isNew = category === '__new';
  $('item-newcat-field').hidden = !isNew;
  const names = isNew ? [] : [...new Set([...subsFor(book, category), ...catalogSubs(book, category)])];
  const none = el('option', '', 'None');
  none.value = '';
  const fresh = el('option', '', 'New subcategory');
  fresh.value = '__new';
  $('item-sub').replaceChildren(none, ...names.map((n) => { const o = el('option', '', n); o.value = n; return o; }), fresh);
  $('item-sub').value = current;
  $('item-newsub-field').hidden = true;
}

function openItemEdit(name, book, onPick) {
  itemDraft = { book, onPick };
  $('item-name').value = name.trim();
  $('item-newcat').value = '';
  $('item-newsub').value = '';
  $('item-error').hidden = true;
  fillItemCats(book, null);
  $('item-edit').showModal();
}

async function submitItemEdit(ev) {
  ev.preventDefault();
  const fail = (m) => { $('item-error').textContent = m; $('item-error').hidden = false; };
  const name = cleanListName($('item-name').value);
  const newCat = cleanListName($('item-newcat').value);
  const newSub = cleanListName($('item-newsub').value);
  const category = $('item-cat').value === '__new' ? newCat : $('item-cat').value;
  const sub = $('item-sub').value === '__new' ? newSub : $('item-sub').value;
  if (!name) return fail('Enter the item name.');
  if (!category) return fail('Enter the new category name.');
  if ($('item-sub').value === '__new' && !sub) return fail('Enter the new subcategory name.');
  if ([name, category, sub].some((v) => LONG_NUMBER.test(v))) return fail(NUMBER_WARNING);
  const { book, onPick } = itemDraft;
  const existing = itemsFor(book).find((i) => i.n === norm(name));
  if (existing && existing.custom) return fail(`${name} is already in your items. Search for it and select it.`);
  await saveListItem({ kind: 'item', name, book, type: category, linked: sub, owner: isStaff() ? state.config.person : '' });
  await ensureLists(book, category, sub);
  $('item-edit').close();
  onPick({ name, book, category, sub, custom: true, n: norm(name), a: [], where: norm(`${category} ${sub}`) });
  renderAll();
  toast(`Added ${name}`);
}

function renderDate() {
  const day = state.date || isoDay();
  const input = $('entry-date');
  // A background sync must not disturb a date picker that is open.
  if (document.activeElement !== input) input.value = day;
  input.max = isoDay();
  $('date-label').textContent = dayLabel(day);
  document.querySelector('.date-chip').classList.toggle('other', !!state.date);
}

async function logExpense() {
  const { rows, total, problem } = buildRows();
  if (problem) return;
  const now = Date.now();
  const via = currentVia();
  const orderId = rows.length > 1 ? newId() : '';
  const date = state.date || isoDay();
  const book = state.book;
  const saved = rows.map((r, i) => ({
    id: newId(),
    date,
    amount: fromPaise(r.paise),
    book,
    item: r.item.slice(0, 240),
    receipt: '',
    category: r.category,
    via: via ? via.name : '',
    viaType: via ? via.type : '',
    viaLinked: (via && via.linked) || '',
    subcategory: r.sub,
    labels: [],
    orderId,
    note: r.note || '',
    person: state.config.person,
    deleted: false,
    created: now + i,
    updated: now,
    dirty: 1,
  }));
  for (const entry of saved) await saveLocal(entry);
  const draft = state.draftFiles;
  clearDraft();
  for (const r of rows) await ensureLists(book, r.category, r.sub);
  for (const file of draft) await queueFile(saved[0].id, file);
  if (navigator.vibrate) navigator.vibrate(12);
  renderAll();
  const first = saved[0];
  // An Office expense with no name usually needs one, so ask straight away.
  if (book === 'Office' && !first.item && saved.length === 1) {
    openEdit(first.id, true, true);
  } else {
    const what = saved.length > 1 ? `${saved.length} items` : [first.item, first.note, first.subcategory ? `${first.category}: ${first.subcategory}` : first.category].filter(Boolean).join(', ');
    toast(`Saved ${money(fromPaise(total))}`, {
      sub: [what, first.via, dayLabel(date), draft.length ? `${draft.length} ${draft.length === 1 ? 'file' : 'files'}` : '',
        missingOf(first).length ? missingText(missingOf(first)) : ''].filter(Boolean).join(', '),
      saved: true,
      undo: () => undoSaved(saved.map((e) => e.id)),
      note: () => openEdit(first.id, true, true),
    });
  }
  syncNow();
}

// Undo means the expense was a mistake, so its files go too.
async function undoSaved(ids) {
  for (const id of ids) {
    for (const f of state.fileQueue.filter((x) => x.entryId === id)) await dropQueued(f.id);
    const e = state.entries.find((x) => x.id === id);
    for (const f of (e && e.files) || []) {
      backendCall({ op: 'removeFile', entryId: id, fileId: f.id }).catch(() => {});
    }
    await removeEntry(id, true);
  }
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

async function removeOrder(orderId) {
  const lines = live().filter((e) => e.orderId === orderId);
  const stamp = Date.now();
  for (const e of lines) await saveLocal({ ...e, deleted: true, updated: Math.max(stamp, e.updated + 1), dirty: 1 });
  renderAll();
  toast(`Deleted order of ${lines.length} items`, {
    undo: async () => {
      for (const e of lines) {
        const cur = state.entries.find((x) => x.id === e.id);
        await saveLocal({ ...cur, deleted: false, updated: Math.max(Date.now(), cur.updated + 1), dirty: 1 });
      }
      renderAll();
      syncNow();
    },
  });
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
  const box = $('toast');
  const ms = actions.undo ? 4500 : 2500;
  box.classList.remove('timed');
  void box.offsetWidth; // restarts the countdown bar
  box.classList.toggle('saved', !!actions.saved);
  box.classList.toggle('timed', !!actions.undo);
  box.style.setProperty('--toast-ms', `${ms}ms`);
  $('toast-text').textContent = text;
  $('toast-sub').textContent = actions.sub || '';
  renderToastSync();
  const set = (id, fn) => {
    const b = $(id);
    b.hidden = !fn;
    b.onclick = fn ? () => { $('toast').hidden = true; fn(); } : null;
  };
  set('toast-undo', actions.undo);
  set('toast-note', actions.note);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, ms);
}

/* ---------- History ---------- */

function monthEntries(month) {
  return inBook().filter((e) => e.date.startsWith(month));
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

/* ---------- Dues ---------- */

function dueData(l) {
  let d = {};
  try { d = JSON.parse(l.details) || {}; } catch (err) { /* treated as empty */ }
  return { amount: Number(d.amount) || 0, varies: !!d.varies, every: Number(d.every) || 0, day: Number(d.day) || 1,
    next: d.next || '', total: Number(d.total) || 0, paid: Number(d.paid) || 0, via: d.via || '', note: d.note || '' };
}

// Moves by whole months and keeps the chosen day, so the 31st becomes the 28th in February and returns to the 31st.
function addMonths(iso, months, day) {
  const [y, m] = iso.split('-').map(Number);
  const first = new Date(y, m - 1 + months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return isoDay(new Date(first.getFullYear(), first.getMonth(), Math.min(day, last)));
}

function afterPayment(d) {
  const paid = d.paid + 1;
  const finished = !d.every || (d.total && paid >= d.total);
  return { ...d, paid, next: finished ? '' : addMonths(d.next, d.every, d.day) };
}

const repeatLabel = (d) => (!d.every ? 'One time' : d.every === 1 ? 'Monthly' : d.every === 12 ? 'Yearly' : `Every ${d.every} months`);
const daysUntil = (iso) => Math.round((parseDay(iso) - parseDay(isoDay())) / 86400000);

function dueWhen(d) {
  const n = daysUntil(d.next);
  const date = parseDay(d.next).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: n > 300 ? 'numeric' : undefined });
  if (n < -1) return `Overdue by ${-n} days, was due ${date}`;
  if (n === -1) return `Overdue by 1 day, was due ${date}`;
  if (n === 0) return 'Due today';
  if (n === 1) return 'Due tomorrow';
  if (n <= 7) return `Due in ${n} days, ${date}`;
  return `Due ${date}`;
}

async function saveDue(fields, data, base) {
  return saveListItem({ kind: 'due', ...fields, details: JSON.stringify(data) }, base);
}

function renderDues() {
  const dues = liveList('due').map((l) => ({ l, d: dueData(l) }));
  const active = dues.filter((x) => x.d.next).sort((a, b) => a.d.next.localeCompare(b.d.next));
  const overdue = active.filter((x) => daysUntil(x.d.next) < 0);
  const soon = active.filter((x) => { const n = daysUntil(x.d.next); return n >= 0 && n <= 7; });
  const later = active.filter((x) => daysUntil(x.d.next) > 7);
  const done = dues.filter((x) => !x.d.next);
  const attention = overdue.length + soon.length;
  const count = $('dues-count');
  count.hidden = !attention;
  count.textContent = String(attention);
  count.setAttribute('aria-label', `${attention} due soon or overdue`);

  const line = $('dues-total');
  const fixed = [...overdue, ...soon].filter((x) => !x.d.varies).reduce((t, x) => t + toPaise(x.d.amount), 0);
  line.hidden = !fixed;
  line.textContent = fixed ? `${money(fromPaise(fixed))} due in the next 7 days, including anything overdue` : '';

  const rowFor = ({ l, d }, state_) => {
    const row = el('div', `due-row ${state_}`);
    const main = el('button', 'due-main');
    main.type = 'button';
    main.setAttribute('aria-label', `Edit ${l.name}`);
    main.addEventListener('click', () => openDueEdit(l));
    main.append(el('span', 'due-name', l.name), el('span', 'due-amount', d.varies ? 'Varies' : money(d.amount)));
    const bits = [d.note, d.next ? dueWhen(d) : 'Finished', d.next ? repeatLabel(d) : '', d.total ? `${d.paid} of ${d.total} paid` : '', d.via, l.book === 'Office' ? 'Office' : ''];
    main.append(el('span', 'due-when', bits.filter(Boolean).join(', ')));
    row.append(main);
    if (d.next) {
      const actions = el('div', 'due-actions');
      const pay = el('button', 'due-pay', 'Mark paid');
      pay.type = 'button';
      pay.setAttribute('aria-label', `Mark ${l.name} paid`);
      pay.addEventListener('click', () => openDuePay(l));
      actions.append(pay);
      if (d.every) {
        const skip = el('button', 'due-skip', 'Skip');
        skip.type = 'button';
        skip.setAttribute('aria-label', `Skip this ${l.name}`);
        skip.addEventListener('click', () => skipDue(l));
        actions.append(skip);
      }
      row.append(actions);
    }
    return row;
  };
  const group = (title, items, cls) => {
    if (!items.length) return [];
    return [el('div', `due-group ${cls}`, `${title} (${items.length})`), ...items.map((x) => rowFor(x, cls))];
  };
  const nodes = [...group('Overdue', overdue, 'overdue'), ...group('Due soon', soon, 'soon'), ...group('Later', later, 'later'), ...group('Finished', done, 'done')];
  $('dues-list').replaceChildren(...(nodes.length ? nodes
    : [el('div', 'empty-state', 'No dues yet. Add your rent, EMIs, and regular bills to see what is coming up.')]));
}

let dueDraft = null;

function fillDueCats(current, sub) {
  const book = $('due-book').value;
  const names = [...new Set([...catsFor(book), ...catalogCats(book)])];
  fillSelect($('due-cat'), names, current && (names.includes(current) || current) ? current : names[0]);
  fillDueSubs(sub);
}

function fillDueSubs(current) {
  const book = $('due-book').value;
  const category = $('due-cat').value;
  const names = [...new Set([...subsFor(book, category), ...catalogSubs(book, category)])];
  if (current && !names.includes(current)) names.push(current);
  const none = el('option', '', 'None');
  none.value = '';
  $('due-sub').replaceChildren(none, ...names.map((n) => { const o = el('option', '', n); o.value = n; return o; }));
  $('due-sub').value = current || '';
  $('due-sub-field').hidden = !names.length;
}

function syncDueFields() {
  $('due-amount').disabled = $('due-varies').checked;
  if ($('due-varies').checked) $('due-amount').value = '';
  $('due-emi').hidden = $('due-every').value === '0';
}

function openDueEdit(l) {
  dueDraft = l || null;
  const d = l ? dueData(l) : { every: 1, next: isoDay(), total: 0, paid: 0, amount: 0, varies: false, via: '' };
  $('due-title').textContent = l ? 'Edit due' : 'Add a due';
  $('due-name').value = l ? l.name : '';
  $('due-amount').value = d.amount ? String(d.amount) : '';
  $('due-varies').checked = d.varies;
  $('due-date').value = d.next || isoDay();
  $('due-every').value = String(d.every);
  $('due-total').value = d.total ? String(d.total) : '';
  $('due-paid').value = d.paid ? String(d.paid) : '';
  $('due-note').value = d.note || '';
  fillSelect($('due-book'), BOOKS, l ? l.book : state.book);
  fillVia(d.via, $('due-via'));
  fillDueCats(l ? l.type : 'Bills', l ? l.linked : '');
  syncDueFields();
  $('due-delete').hidden = !l;
  $('due-error').hidden = true;
  closeResults($('due-results'));
  $('due-edit').showModal();
  if (!l) $('due-name').focus();
}

async function submitDue(ev) {
  ev.preventDefault();
  const fail = (m) => { $('due-error').textContent = m; $('due-error').hidden = false; };
  const name = cleanListName($('due-name').value);
  const varies = $('due-varies').checked;
  const amount = varies ? 0 : Math.round(parseFloat($('due-amount').value.replace(/[,₹\s]/g, '')) * 100) / 100;
  const next = $('due-date').value;
  const every = Number($('due-every').value);
  const total = every ? (parseInt($('due-total').value, 10) || 0) : 0;
  const paid = every ? (parseInt($('due-paid').value, 10) || 0) : 0;
  if (!name) return fail('Enter what this due is for.');
  if (LONG_NUMBER.test(name)) return fail(NUMBER_WARNING);
  if (!varies && !(amount > 0)) return fail('Enter the amount, or tick that it changes each time.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return fail('Choose the next due date.');
  if (total && paid >= total) return fail('Already paid must be less than total payments.');
  const old = dueDraft ? dueData(dueDraft) : null;
  const sameDate = old && old.next === next;
  const data = { amount, varies, every, day: sameDate ? old.day : Number(next.slice(8)), next, total, paid, via: $('due-via').value, note: $('due-note').value.trim() };
  await saveDue({ name, book: $('due-book').value, type: $('due-cat').value, linked: $('due-sub').value }, data, dueDraft || undefined);
  $('due-edit').close();
  renderAll();
  toast(`Saved ${name}`);
}

let payingDue = null;

function openDuePay(l) {
  payingDue = l;
  const d = dueData(l);
  $('pay-title').textContent = `Pay ${l.name}`;
  $('pay-progress').textContent = [dueWhen(d), d.total ? `Payment ${d.paid + 1} of ${d.total}` : ''].filter(Boolean).join('. ');
  $('pay-amount').value = d.amount ? String(d.amount) : '';
  $('pay-date').value = isoDay();
  $('pay-date').max = isoDay();
  $('pay-note').value = d.note;
  fillVia(d.via, $('pay-via'));
  $('pay-error').hidden = true;
  $('due-pay').showModal();
  if (!d.amount) $('pay-amount').focus();
}

async function submitPay(ev) {
  ev.preventDefault();
  const fail = (m) => { $('pay-error').textContent = m; $('pay-error').hidden = false; };
  const amount = Math.round(parseFloat($('pay-amount').value.replace(/[,₹\s]/g, '')) * 100) / 100;
  const date = $('pay-date').value;
  if (!(amount > 0)) return fail('Enter the amount paid.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Choose the date paid.');
  const l = payingDue;
  const d = dueData(l);
  const via = instruments().find((i) => i.name === $('pay-via').value);
  const now = Date.now();
  const entry = {
    id: newId(), date, amount, book: l.book, item: l.name, receipt: '', category: l.type || 'Bills',
    via: via ? via.name : $('pay-via').value, viaType: via ? via.type : '', viaLinked: (via && via.linked) || '',
    subcategory: l.linked || '', labels: [], orderId: '', note: $('pay-note').value.trim(), person: state.config.person,
    deleted: false, created: now, updated: now, dirty: 1,
  };
  await saveLocal(entry);
  await ensureLists(entry.book, entry.category, entry.subcategory);
  const before = state.lists.find((x) => x.id === l.id);
  const moved = await saveDue({}, afterPayment(d), before);
  $('due-pay').close();
  renderAll();
  toast(`Saved ${money(amount)}`, {
    sub: [l.name, entry.note, entry.via, moved && dueData(moved).next ? `Next due ${parseDay(dueData(moved).next).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : 'Finished'].filter(Boolean).join(', '),
    saved: true,
    undo: async () => {
      await removeEntry(entry.id, true);
      const cur = state.lists.find((x) => x.id === l.id);
      await saveDue({}, d, cur);
      renderAll();
    },
    note: () => openEdit(entry.id, true, true),
  });
  syncNow();
}

async function skipDue(l) {
  const d = dueData(l);
  const next = addMonths(d.next, d.every, d.day);
  await saveDue({}, { ...d, next }, state.lists.find((x) => x.id === l.id));
  renderAll();
  toast(`Skipped. Next due ${parseDay(next).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`, {
    undo: async () => {
      await saveDue({}, d, state.lists.find((x) => x.id === l.id));
      renderAll();
    },
  });
}

function loadReminders() {
  const rule = liveList('rule').find((r) => r.book === 'Reminders');
  let s = {};
  try { s = rule ? JSON.parse(rule.details) : {}; } catch (err) { /* empty */ }
  $('rem-emails').value = s.emails || '';
  $('rem-days').value = String(s.days || 3);
  $('rem-error').hidden = true;
}

async function saveReminders() {
  const emails = $('rem-emails').value.split(',').map((e) => e.trim()).filter(Boolean);
  if (emails.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) {
    $('rem-error').textContent = 'Check the email addresses, and separate them with commas.';
    $('rem-error').hidden = false;
    return false;
  }
  $('rem-error').hidden = true;
  const base = liveList('rule').find((r) => r.book === 'Reminders');
  await saveListItem({ kind: 'rule', name: 'Reminders', book: 'Reminders', details: JSON.stringify({ emails: emails.join(', '), days: Number($('rem-days').value) }) }, base);
  return true;
}

/* ---------- Required details ---------- */

function ruleFor(book) {
  return liveList('rule').find((r) => r.book === book);
}

function requiredFor(book) {
  const rule = ruleFor(book);
  return rule ? rule.linked.split(',').filter(Boolean) : (REQUIRED_DEFAULTS[book] || []);
}

// Invoice and receipt belong to the whole order, so one on any line is enough.
function orderLines(e) {
  return e.orderId ? live().filter((x) => x.orderId === e.orderId) : [e];
}

function missingOf(e) {
  const need = requiredFor(bookOf(e));
  const lines = orderLines(e);
  const out = [];
  if (need.includes('invoice') && !lines.some((x) => (x.files || []).length || state.fileQueue.some((f) => f.entryId === x.id))) out.push('invoice');
  if (need.includes('receipt') && !lines.some((x) => x.receipt)) out.push('receipt');
  if (need.includes('via') && !e.via) out.push('via');
  if (need.includes('date') && !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) out.push('date');
  if (need.includes('name') && !e.item) out.push('name');
  return out;
}

const missingText = (fields) => `Missing ${fields.map((f) => REQUIRED_FIELDS[f]).join(', ')}`;

function flaggedEntries() {
  return inBook().filter((e) => (state.filter === 'all' || e.person === state.filter) && missingOf(e).length)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.created - a.created));
}

// An order counts once, however many of its lines are affected.
function countFlagged(list) {
  return new Set(list.map((e) => e.orderId || e.id)).size;
}

function renderNeeds() {
  const flagged = flaggedEntries();
  const box = $('needs-filter');
  const count = $('tab-count');
  const total = countFlagged(inBook().filter((e) => missingOf(e).length));
  count.hidden = !total;
  count.textContent = String(total);
  count.setAttribute('aria-label', `${total} need details`);
  if (state.needs && state.needs !== 'all' && !flagged.some((e) => missingOf(e).includes(state.needs))) state.needs = flagged.length ? 'all' : null;
  if (state.needs === 'all' && !flagged.length) state.needs = null;
  const chip = (value, text) => {
    const b = el('button', '', text);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.needs === value));
    b.addEventListener('click', () => { state.needs = state.needs === value ? null : value; renderHistory(); });
    return b;
  };
  const nodes = [];
  if (flagged.length) nodes.push(chip('all', `Needs details (${countFlagged(flagged)})`));
  if (state.needs) {
    Object.keys(REQUIRED_FIELDS).forEach((f) => {
      const n = countFlagged(flagged.filter((e) => missingOf(e).includes(f)));
      if (n) nodes.push(chip(f, `${REQUIRED_LABELS[f]} (${n})`));
    });
  }
  box.replaceChildren(...nodes);
  $('history-months').hidden = !!state.needs;
}

function renderRules() {
  const need = requiredFor(state.book);
  const rows = Object.keys(REQUIRED_FIELDS).map((f) => {
    const label = el('label', 'rule-row');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = need.includes(f);
    box.dataset.field = f;
    box.addEventListener('change', async () => {
      const chosen = [...document.querySelectorAll('#m-rules-body input')].filter((c) => c.checked).map((c) => c.dataset.field);
      await saveListItem({ kind: 'rule', name: `Required in ${state.book}`, book: state.book, linked: chosen.join(',') }, ruleFor(state.book));
      renderAll();
    });
    label.append(box, document.createTextNode(REQUIRED_LABELS[f]));
    return label;
  });
  $('m-rules-body').replaceChildren(el('p', 'note', `Expenses in ${state.book} missing any of these are flagged. Applies to everyone using this book.`), ...rows);
}

function renderEditMissing() {
  const e = state.entries.find((x) => x.id === editingId);
  if (!e || !$('edit').open) return;
  const fields = missingOf(e);
  $('edit-missing').hidden = !fields.length;
  $('edit-missing').textContent = fields.length ? missingText(fields) : '';
  $('edit-via-field').classList.toggle('is-missing', fields.includes('via'));
  $('edit-receipt-field').classList.toggle('is-missing', fields.includes('receipt'));
  $('edit-date-field').classList.toggle('is-missing', fields.includes('date'));
  document.querySelector('.files-box').classList.toggle('is-missing', fields.includes('invoice'));
  $('edit-item').parentElement.classList.toggle('is-missing', fields.includes('name'));
  const next = state.needs && flaggedEntries().some((x) => x.id !== e.id && (x.orderId !== e.orderId || !e.orderId));
  $('edit-next').hidden = !next;
}

function renderHistory() {
  renderNeeds();
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
    filter.replaceChildren(chip('all', people.length > 2 ? 'Everyone' : 'Both'), ...people.map((p) => chip(p, p)));
  } else {
    filter.replaceChildren();
    state.filter = 'all';
  }

  const rows = state.needs
    ? flaggedEntries().filter((e) => state.needs === 'all' || missingOf(e).includes(state.needs))
    : monthEntries(state.month)
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
  let orderShown = null;
  let pendingHead = null;
  for (const e of rows) {
    if (e.orderId && e.orderId !== orderShown) {
      orderShown = e.orderId;
      const lines = rows.filter((x) => x.orderId === e.orderId);
      if (lines.length > 1) {
        const head = el('div', 'order-head');
        head.append(el('span', '', `Order of ${lines.length} items`), el('span', '', money(fromPaise(lines.reduce((t, x) => t + toPaise(x.amount), 0)))));
        const shared = missingOf(e).filter((f) => f === 'invoice' || f === 'receipt');
        if (shared.length) {
          head.classList.add('flagged');
          head.append(el('span', 'order-missing', missingText(shared)));
        }
        pendingHead = head;
      }
    } else if (!e.orderId) {
      orderShown = null;
    }
    if (e.date !== day) {
      day = e.date;
      const sum = rows.filter((x) => x.date === day).reduce((s, x) => s + toPaise(x.amount), 0);
      const head = el('div', 'day-head');
      head.append(el('span', '', dayLabel(day)), el('span', '', money(fromPaise(sum))));
      out.push(head);
    }
    if (pendingHead) { out.push(pendingHead); pendingHead = null; }
    const inOrder = e.orderId && rows.filter((x) => x.orderId === e.orderId).length > 1;
    const row = el('button', inOrder ? 'row in-order' : 'row');
    row.type = 'button';
    row.setAttribute('aria-label', `Edit ${money(e.amount)}, ${e.category}`);
    const main = el('span', 'row-main');
    main.append(el('span', 'row-cat', e.item || e.category));
    const fileCount = (e.files || []).length + state.fileQueue.filter((f) => f.entryId === e.id).length;
    const place = e.item ? [e.category, e.subcategory] : [e.subcategory];
    const bits = [e.note, ...place, (e.labels || []).join(', '), e.receipt ? `Receipt ${e.receipt}` : '', e.person, e.via,
      fileCount ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'}` : '']
      .filter(Boolean).join(', ');
    if (bits) main.append(el('span', 'row-sub', bits));
    const amt = el('span', 'row-amt', money(e.amount));
    if (e.dirty) amt.append(el('span', 'row-wait', 'Not synced yet'));
    const lacking = missingOf(e).filter((f) => !inOrder || (f !== 'invoice' && f !== 'receipt'));
    if (lacking.length) {
      row.classList.add('flagged');
      main.append(el('span', 'row-missing', missingText(lacking)));
    }
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

  const tally = (keyOf) => {
    const m = new Map();
    rows.forEach((e) => {
      (keyOf(e) || []).forEach((k) => m.set(k, (m.get(k) || 0) + toPaise(e.amount)));
    });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const barList = (items) => {
    const ul = el('ul', 'bars');
    const top = items[0][1];
    items.forEach(([name, p]) => {
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
    return ul;
  };
  const extraLists = [
    ['By subcategory', tally((e) => (e.subcategory ? [`${e.category}: ${e.subcategory}`] : []))],
    ['By payment method', tally((e) => (e.via ? [e.via] : []))],
    ['By label', tally((e) => e.labels || [])],
  ];

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
  extraLists.forEach(([title, items]) => {
    if (items.length) nodes.push(el('h3', 'section-title', title), barList(items));
  });
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

function openEdit(id, focusDetails, justSaved) {
  const e = state.entries.find((x) => x.id === id);
  if (!e || e.deleted) return;
  editingId = id;
  $('edit-amount').value = String(e.amount);
  fillSelect($('edit-book'), BOOKS, bookOf(e));
  fillSelect($('edit-category'), catsFor(bookOf(e)), e.category);
  $('edit-item').value = e.item || '';
  closeResults($('edit-results'));
  $('edit-receipt').value = e.receipt || '';
  $('edit-more').open = !!(justSaved || e.receipt || e.note || (e.labels || []).length || missingOf(e).includes('receipt'));
  $('edit-delete-order').hidden = !(e.orderId && live().filter((x) => x.orderId === e.orderId).length > 1);
  $('edit-title').textContent = justSaved ? `Saved ${money(e.amount)}. Add details` : 'Edit expense';
  $('edit-cancel').textContent = justSaved ? 'Skip' : 'Cancel';
  fillVia(e.via);
  state.editLabels = new Set(e.labels || []);
  renderEditLabels();
  fillSubs(e.subcategory);
  $('edit-date').value = e.date;
  $('edit-date').max = isoDay();
  $('edit-note').value = e.note;
  $('edit-by').textContent = e.person ? `Logged by ${e.person}` : '';
  $('edit-error').hidden = true;
  $('edit').showModal();
  renderEditFiles();
  renderEditMissing();
  if (focusDetails) $('edit-item').focus();
}

function fillVia(current, select = $('edit-via')) {
  const list = instruments();
  const groups = groupByType(list).map(([type, items]) => {
    const g = el('optgroup');
    g.label = type;
    items.forEach((i) => { const o = el('option', '', i.name); o.value = i.name; g.append(o); });
    return g;
  });
  select.replaceChildren(...groups);
  if (current && !list.some((i) => i.name === current)) {
    const o = el('option', '', current);
    o.value = current;
    select.append(o);
  }
  select.value = current || (currentVia() ? currentVia().name : '');
}

function fillSubs(current) {
  const subs = subsFor($('edit-book').value, $('edit-category').value);
  const list = current && !subs.includes(current) ? [...subs, current] : subs;
  const select = $('edit-sub');
  const none = el('option', '', 'None');
  none.value = '';
  select.replaceChildren(none, ...list.map((s) => { const o = el('option', '', s); o.value = s; return o; }));
  select.value = current || '';
  $('edit-sub-field').hidden = !list.length;
}

function renderEditLabels() {
  const names = liveList('label').map((l) => l.name);
  state.editLabels.forEach((n) => { if (!names.includes(n)) names.push(n); });
  $('edit-labels').replaceChildren(...names.map((name) => {
    const b = el('button', '', name);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.editLabels.has(name)));
    b.addEventListener('click', () => {
      if (state.editLabels.has(name)) state.editLabels.delete(name); else state.editLabels.add(name);
      renderEditLabels();
    });
    return b;
  }));
}

function cleanListName(text) {
  return text.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

const NUMBER_WARNING = 'Do not save full card or account numbers. Use a nickname with the last 4 digits at most.';

async function addLabelFromEdit() {
  const name = cleanListName($('edit-new-label').value);
  if (!name) return;
  if (LONG_NUMBER.test(name)) return showEditError(NUMBER_WARNING);
  $('edit-error').hidden = true;
  $('edit-new-label').value = '';
  const existing = liveList('label').find((l) => l.name.toLowerCase() === name.toLowerCase());
  state.editLabels.add(existing ? existing.name : name);
  renderEditLabels();
  if (!existing) await saveListItem({ kind: 'label', name, book: $('edit-book').value });
  renderEditLabels();
  renderManage();
}

async function saveListItem(fields, base) {
  const now = Date.now();
  const item = {
    id: newId(), book: '', parent: '', type: '', linked: '', owner: '', deleted: false, created: now,
    ...base, ...fields, updated: Math.max(now, base ? base.updated + 1 : now), dirty: 1,
  };
  await putList(item);
  syncNow();
  return item;
}

/* ---------- Managing the shared lists ---------- */

let listDraft = null;

function openListEdit(kind, item, extra = {}) {
  listDraft = { kind, item, extra };
  const isPay = kind === 'instrument';
  const titles = { category: 'category', subcategory: 'subcategory', label: 'label', instrument: 'payment method', item: 'item' };
  $('list-title').textContent = `${item ? 'Edit' : 'Add'} ${titles[kind]}`;
  $('list-name').value = item ? item.name : '';
  $('list-name').placeholder = '';
  $('list-linked').value = item ? item.linked : '';
  $('list-type-field').hidden = !isPay;
  $('list-linked-field').hidden = !isPay;
  $('list-owner-field').hidden = !isPay;
  if (isPay) {
    fillSelect($('list-type'), PAY_TYPES, item ? item.type : 'UPI');
    const example = () => { $('list-name').placeholder = PAY_EXAMPLES[$('list-type').value] || ''; };
    $('list-type').onchange = example;
    example();
    const owners = peopleList();
    if (state.config && !owners.includes(state.config.person)) owners.push(state.config.person);
    const select = $('list-owner');
    const both = el('option', '', 'You and your family');
    both.value = '';
    const office = el('option', '', 'All office staff');
    office.value = 'Office';
    select.replaceChildren(both, office, ...owners.map((p) => { const o = el('option', '', p); o.value = p; return o; }));
    select.value = item ? item.owner : '';
  }
  $('list-note').textContent = isPay
    ? 'Use a nickname with the last 4 digits at most. Never save a full card number, CVV, PIN, or password.'
    : (item ? 'Past expenses keep the name they were saved with.' : '');
  $('list-error').hidden = true;
  $('list-edit').showModal();
  $('list-name').focus();
}

async function submitListEdit(ev) {
  ev.preventDefault();
  const { kind, item, extra } = listDraft;
  const name = cleanListName($('list-name').value);
  const linked = kind === 'instrument' ? $('list-linked').value.trim() : '';
  const fail = (msg) => { $('list-error').textContent = msg; $('list-error').hidden = false; };
  if (!name) return fail('Enter a name.');
  if (LONG_NUMBER.test(name) || LONG_NUMBER.test(linked)) return fail(NUMBER_WARNING);
  const scope = (l) => l.kind === kind && !l.deleted && (!item || l.id !== item.id)
    && (kind !== 'category' || l.book === (item ? item.book : extra.book))
    && (kind !== 'subcategory' || l.parent === (item ? item.parent : extra.parent));
  if (state.lists.some((l) => scope(l) && l.name.toLowerCase() === name.toLowerCase())) {
    return fail(`${name} already exists.`);
  }
  const fields = { kind, name, ...extra };
  if (kind === 'instrument') {
    Object.assign(fields, { type: $('list-type').value, linked, owner: isStaff() ? state.config.person : $('list-owner').value });
  }
  await saveListItem(fields, item || undefined);
  $('list-edit').close();
  renderAll();
}

async function removeListItem(item) {
  await saveListItem({ deleted: true }, item);
  renderAll();
  toast(`Deleted ${item.name}`, {
    undo: async () => {
      const now = state.lists.find((l) => l.id === item.id);
      await saveListItem({ deleted: false }, now);
      renderAll();
    },
  });
}

function manageRow(item, cls, sub, pay) {
  const row = el('div', `m-row ${cls}`);
  const name = el('div', 'm-name', item.name);
  if (sub) name.append(el('small', '', sub));
  row.append(name);
  if (pay) {
    if (pay.isDefault) {
      row.append(el('span', 'default-tag', 'Default'));
    } else {
      const d = el('button', '', 'Make default');
      d.type = 'button';
      d.setAttribute('aria-label', `Make ${item.name} the default for ${item.type}`);
      d.addEventListener('click', async () => {
        state.payDefaults[item.type] = item.id;
        state.viaByBook[state.book] = item.id;
        await db.setMeta('payDefaults', state.payDefaults);
        await db.setMeta('viaByBook', state.viaByBook);
        renderAll();
      });
      row.append(d);
    }
    if (pay.readOnly) return row;
  }
  const edit = el('button', '', 'Edit');
  edit.type = 'button';
  edit.setAttribute('aria-label', `Edit ${item.name}`);
  edit.addEventListener('click', () => openListEdit(item.kind, item));
  const rm = el('button', 'remove', 'Delete');
  rm.type = 'button';
  rm.setAttribute('aria-label', `Delete ${item.name}`);
  rm.addEventListener('click', () => removeListItem(item));
  row.append(edit, rm);
  return row;
}

function addButton(text, fn, cls = 'plain m-add') {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}

function renderManage() {
  renderRules();
  const myItems = liveList('item').filter((i) => i.book === state.book && (!isStaff() || i.owner === state.config.person));
  $('m-items-body').replaceChildren(
    myItems.length
      ? el('p', 'note', `Items you added to ${state.book}. To add one, search for it on the Add screen.`)
      : el('p', 'note', `No added items in ${state.book} yet. To add one, search for it on the Add screen and choose Add as a new item.`),
    ...myItems.map((i) => manageRow(i, '', [i.type, i.linked].filter(Boolean).join(', '))),
  );
  const cats = $('m-cats-body');
  const catNodes = [el('p', 'note', `Showing ${state.book}. Use the Home or Office switch on the Add screen to change book.`)];
  catObjs(state.book).forEach((c) => {
    catNodes.push(manageRow(c, 'cat'));
    liveList('subcategory').filter((s) => s.parent === c.id).forEach((s) => catNodes.push(manageRow(s, 'sub')));
    const row = el('div', 'm-row sub');
    row.append(addButton(`Add subcategory to ${c.name}`, () => openListEdit('subcategory', null, { parent: c.id, book: c.book }), ''));
    catNodes.push(row);
  });
  catNodes.push(addButton('Add category', () => openListEdit('category', null, { book: state.book })));
  cats.replaceChildren(...catNodes);

  const payNodes = [];
  groupByType(liveList('instrument')).forEach(([type, items]) => {
    payNodes.push(el('p', 'm-group', type));
    const mine = defaultFor(type);
    items.forEach((i) => payNodes.push(manageRow(i, '', [i.linked, i.owner].filter(Boolean).join(', '), {
      isDefault: !!mine && mine.id === i.id,
      readOnly: isStaff() && i.owner !== state.config.person,
    })));
  });
  payNodes.push(addButton('Add payment method', () => openListEdit('instrument', null)));
  $('m-pay-body').replaceChildren(...payNodes);

  $('m-labels-body').replaceChildren(
    ...liveList('label').map((l) => manageRow(l, '')),
    addButton('Add label', () => openListEdit('label', null, { book: state.book })),
  );
}

/* ---------- People and access (the backend refuses these for staff) ---------- */

async function loadPeople() {
  const box = $('m-people-body');
  box.replaceChildren(el('p', 'note', 'Loading'));
  let users;
  try {
    ({ users } = await backendCall({ op: 'listUsers' }));
  } catch (err) {
    box.replaceChildren(el('p', 'note', 'Managing people needs an internet connection. Close and reopen this section to try again.'));
    return;
  }
  const nodes = [el('p', 'note', 'Office staff see and change only the Office expenses they logged, with their own files. Each person has their own setup code.')];
  users.forEach((u) => {
    const row = el('div', 'm-row');
    const name = el('div', 'm-name', u.name);
    name.append(el('small', u.active ? '' : 'm-off', u.active ? (u.access === 'Full' ? 'Full access' : 'Office staff') : 'Access removed'));
    const act = (text, cls, body) => {
      const b = el('button', cls, text);
      b.type = 'button';
      b.setAttribute('aria-label', `${text} for ${u.name}`);
      b.addEventListener('click', async () => {
        try {
          const reply = await backendCall({ op: 'setUser', id: u.id, ...body });
          if (reply.key) showCode(u.name, reply.key);
          await loadPeople();
        } catch (err) {
          toast('That needs an internet connection.');
        }
      });
      return b;
    };
    row.append(name, act('New code', '', { newKey: true, active: true }),
      u.active ? act('Remove access', 'remove', { active: false }) : act('Restore', '', { active: true }));
    nodes.push(row);
  });
  nodes.push(addButton('Add a person', () => {
    $('person-name').value = '';
    $('person-access').value = 'Staff';
    $('person-error').hidden = true;
    $('person-edit').showModal();
  }));
  box.replaceChildren(...nodes);
}

function showCode(name, key) {
  $('code-title').textContent = `Setup code for ${name}`;
  $('code-text').value = encodeCode(state.config.url, key, name);
  $('code-copy').textContent = 'Copy code';
  $('person-code').showModal();
}

async function submitPerson(ev) {
  ev.preventDefault();
  const fail = (m) => { $('person-error').textContent = m; $('person-error').hidden = false; };
  const name = $('person-name').value.trim();
  if (!name) return fail('Enter a name.');
  if (LONG_NUMBER.test(name)) return fail('Enter a name, not a number.');
  $('person-save').disabled = true;
  try {
    const reply = await backendCall({ op: 'addUser', name, access: $('person-access').value });
    $('person-edit').close();
    showCode(reply.user.name, reply.key);
    await loadPeople();
  } catch (err) {
    fail(err.code === 'name_taken' ? `${name} already exists. Use a different name.` : 'Adding a person needs an internet connection.');
  } finally {
    $('person-save').disabled = false;
  }
}

function openViaPicker() {
  const now = currentVia() || {};
  const choose = (i) => {
    state.viaByBook[state.book] = i.id;
    db.setMeta('viaByBook', state.viaByBook);
    $('via-picker').close();
    renderCats();
  };
  const option = (i) => {
    const b = el('button', 'via-option', i.name);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(i.id === now.id));
    const line = [i.linked, i.owner].filter(Boolean).join(', ');
    if (line) b.append(el('small', '', line));
    b.addEventListener('click', () => choose(i));
    return b;
  };
  const mine = minePay();
  const me = state.config ? state.config.person : '';
  const recent = [];
  [...state.entries].sort((a, b) => b.created - a.created).forEach((e) => {
    if (e.deleted || e.person !== me || recent.length >= 3) return;
    const i = mine.find((m) => m.name === e.via);
    if (i && !recent.includes(i)) recent.push(i);
  });
  const nodes = [];
  if (recent.length) nodes.push(el('p', 'via-group', 'Recent'), ...recent.map(option));
  groupByType(mine).forEach(([type, items]) => {
    // Each method appears once: anything under Recent is left out here.
    const rest = items.filter((i) => !recent.includes(i));
    if (!rest.length) return;
    const top = rest.find((i) => i.id === defaultFor(type).id) || rest[0];
    const others = rest.filter((i) => i.id !== top.id);
    nodes.push(el('p', 'via-group', type), option(top));
    if (others.length) {
      const more = el('button', 'via-more', `${others.length} more`);
      more.type = 'button';
      more.setAttribute('aria-label', `Show ${others.length} more under ${type}`);
      more.addEventListener('click', () => more.replaceWith(...others.map(option)));
      nodes.push(more);
    }
  });
  if (!mine.length) nodes.push(el('p', 'note', 'Add a payment method to choose it here.'));
  $('via-list').replaceChildren(...nodes);
  $('via-picker').showModal();
}

async function submitEdit(ev) {
  ev.preventDefault();
  const goNext = !!(ev.submitter && ev.submitter.id === 'edit-next') || state.editNext;
  state.editNext = false;
  const e = state.entries.find((x) => x.id === editingId);
  if (!e) { $('edit').close(); return; }
  const amount = Math.round(parseFloat($('edit-amount').value.replace(/[,₹\s]/g, '')) * 100) / 100;
  const date = $('edit-date').value;
  if (!(amount > 0)) return showEditError('Enter an amount above zero.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showEditError('Choose a date.');
  const picked = instruments().find((i) => i.name === $('edit-via').value);
  const next = {
    ...e,
    amount, date,
    book: $('edit-book').value,
    subcategory: $('edit-sub').value,
    labels: [...state.editLabels],
    viaType: picked ? picked.type : e.viaType,
    viaLinked: picked ? picked.linked : e.viaLinked,
    item: $('edit-item').value.trim(),
    receipt: $('edit-receipt').value.trim(),
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
  if (goNext) {
    const upcoming = flaggedEntries().find((x) => x.id !== next.id && !(next.orderId && x.orderId === next.orderId));
    if (upcoming) { $('toast').hidden = true; openEdit(upcoming.id); }
  }
}

function showEditError(msg) {
  $('edit-error').textContent = msg;
  $('edit-error').hidden = false;
}

/* ---------- Rendering and navigation ---------- */

function renderToday() {
  const today = isoDay();
  const sum = inBook().filter((e) => e.date === today).reduce((s, e) => s + toPaise(e.amount), 0);
  $('today-total').textContent = money(fromPaise(sum));
}

function renderAll() {
  renderBooks();
  renderToday();
  renderMonthNavs();
  renderHistory();
  renderSummary();
  renderStatus();
  renderCats();
  renderDate();
  renderEditFiles();
  renderEditMissing();
  renderDues();
  renderManage();
  if (state.config) $('set-name').textContent = state.config.person;
}

function go(view) {
  if (view !== state.view) $('toast').hidden = true; // never left covering the next screen
  state.view = view;
  document.body.dataset.view = view;
  document.querySelectorAll('[data-go]').forEach((b) => {
    if (b.dataset.go === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

/* ---------- Setup ---------- */

function encodeCode(url, key, name) {
  const raw = JSON.stringify({ u: url, k: key, n: name || undefined });
  return CODE_PREFIX + btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeCode(code) {
  const c = code.trim();
  if (!c.startsWith(CODE_PREFIX)) return null;
  try {
    const b = c.slice(CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(atob(b));
    return o.u && o.k ? { url: o.u, key: o.k, name: o.n || '' } : null;
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
    if (!conn || !validUrl(conn.url)) return setupError('That setup code is not valid. Copy it again.');
    delete conn.name;
  }
  const person = $('setup-name').value.trim();
  if (!person) return setupError('Enter your name, so that you can both see who logged what.');

  const go1 = $('setup-go');
  go1.disabled = true;
  go1.textContent = 'Connecting';
  try {
    const reply = await callBackend(conn.url, { key: conn.key, op: 'sync', since: 0, changes: [] });
    const config = { ...conn, person, deviceId: newId() };
    state.config = config;
    await db.setMeta('config', config);
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
  go(state.view);
  renderAll();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  rememberProfile();
  if (!state.pinRec) showLock('create');
  else if (idleExpired()) showLock('unlock');
  else hideLock();
  syncNow(); // unsynced entries keep moving even while the screen is locked
}

/* ---------- Theme: one choice for the whole device ---------- */

function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll('#theme-switch button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.choice === (choice || 'system')));
  });
}

function loadTheme() {
  let choice = 'system';
  try { choice = localStorage.getItem('kharcha-theme') || 'system'; } catch (err) { /* follow the device */ }
  applyTheme(choice);
}

/* ---------- PIN lock ---------- */
/* This is a screen lock for this device. It works offline, so it is checked here. */

const pinState = { mode: null, buf: '', first: '', changing: false, busy: false, fails: 0, until: 0, timer: null };
const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hashPin(pin, salt, rounds) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, key, 256);
  return toB64(bits);
}

async function savePin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  state.pinRec = { salt: toB64(salt), rounds: PIN_ROUNDS, hash: await hashPin(pin, salt, PIN_ROUNDS) };
  await db.setMeta('pin', state.pinRec);
}

function touch() {
  if (state.leaving) return; // reloading to another account must not count as still in use
  try { localStorage.setItem(seenKey(), String(Date.now())); } catch (err) { /* it will simply ask again */ }
}

function idleExpired() {
  try {
    const seen = Number(localStorage.getItem(seenKey()));
    return !seen || Date.now() - seen > IDLE_MS;
  } catch (err) { return true; }
}

const isLocked = () => !$('lock').hidden;

function renderLock(message) {
  const titles = {
    create: pinState.changing ? 'Choose a new 4-digit PIN' : 'Choose a 4-digit PIN for this device',
    confirm: 'Enter the same PIN again',
    unlock: 'Enter your PIN',
    current: 'Enter your current PIN',
  };
  $('lock-title').textContent = titles[pinState.mode];
  if (message !== undefined) $('lock-msg').textContent = message;
  document.querySelectorAll('#lock-dots span').forEach((d, i) => d.classList.toggle('on', i < pinState.buf.length));
  $('pin-forgot').hidden = pinState.mode !== 'unlock';
  $('pin-accounts').hidden = pinState.mode !== 'unlock' || state.profiles.length < 2;
  $('pin-cancel').hidden = !pinState.changing;
}

function showLock(mode, changing = false) {
  closeViewer();
  ['edit', 'confirm', 'via-picker', 'list-edit', 'person-edit', 'person-code', 'accounts', 'item-edit', 'cat-picker', 'due-edit', 'due-pay'].forEach((id) => { if ($(id).open) $(id).close(); });
  $('toast').hidden = true;
  clearDraft();
  renderCats();
  pinState.mode = mode;
  pinState.changing = changing;
  pinState.buf = '';
  // Reopening or reloading must not get past a screen that is already locked.
  try { localStorage.removeItem(seenKey()); } catch (err) { /* it will simply ask again */ }
  $('app').hidden = true;
  $('lock').hidden = false;
  renderLock('');
  tickLockout();
}

function hideLock(message) {
  clearInterval(pinState.timer);
  pinState.buf = '';
  pinState.changing = false;
  $('lock').hidden = true;
  $('app').hidden = false;
  touch();
  if (message) toast(message);
}

function tickLockout() {
  clearInterval(pinState.timer);
  const show = () => {
    const left = Math.ceil((pinState.until - Date.now()) / 1000);
    if (left > 0) {
      $('lock-msg').textContent = `Too many wrong tries. Try again in ${left} seconds.`;
    } else {
      clearInterval(pinState.timer);
      if (/^Too many/.test($('lock-msg').textContent)) $('lock-msg').textContent = '';
    }
  };
  if (pinState.until > Date.now()) {
    show();
    pinState.timer = setInterval(show, 1000);
  }
}

async function recordFail() {
  pinState.fails += 1;
  if (pinState.fails >= PIN_FREE_TRIES) {
    const wait = Math.min(30000 * 2 ** (pinState.fails - PIN_FREE_TRIES), 15 * 60 * 1000);
    pinState.until = Date.now() + wait;
  }
  await db.setMeta('pinFails', { fails: pinState.fails, until: pinState.until });
  if (pinState.until > Date.now()) { renderLock(''); tickLockout(); return; }
  const left = PIN_FREE_TRIES - pinState.fails;
  renderLock(`Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before a wait.`);
}

async function checkPin(pin) {
  const r = state.pinRec;
  return (await hashPin(pin, fromB64(r.salt), r.rounds)) === r.hash;
}

async function pinDone() {
  const pin = pinState.buf;
  pinState.buf = '';
  const mode = pinState.mode;
  if (mode === 'create') {
    pinState.first = pin;
    pinState.mode = 'confirm';
    renderLock('');
  } else if (mode === 'confirm') {
    if (pin !== pinState.first) {
      pinState.mode = 'create';
      renderLock('Those PINs did not match. Choose a PIN again.');
      return;
    }
    const changing = pinState.changing;
    await savePin(pin);
    pinState.first = '';
    hideLock(changing ? 'PIN changed' : '');
  } else if (await checkPin(pin)) {
    pinState.fails = 0;
    pinState.until = 0;
    await db.setMeta('pinFails', { fails: 0, until: 0 });
    if (mode === 'current') {
      pinState.mode = 'create';
      renderLock('');
    } else {
      hideLock();
    }
  } else {
    await recordFail();
  }
}

async function pinPress(k) {
  if (pinState.busy) return;
  if (pinState.until > Date.now() && (pinState.mode === 'unlock' || pinState.mode === 'current')) return;
  if (k === 'back') pinState.buf = pinState.buf.slice(0, -1);
  else if (pinState.buf.length < PIN_LENGTH) pinState.buf += k;
  $('lock-msg').textContent = '';
  renderLock();
  if (pinState.buf.length === PIN_LENGTH) {
    pinState.busy = true;
    try { await pinDone(); } finally { pinState.busy = false; }
  }
}

function checkIdle() {
  if (state.config && state.pinRec && !isLocked() && idleExpired()) showLock('unlock');
}

/* ---------- Wiring ---------- */

function wire_() {
  document.querySelector('#lock .keys').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b) pinPress(b.dataset.pin);
  });
  $('pin-cancel').addEventListener('click', () => hideLock());
  $('pin-forgot').addEventListener('click', async () => {
    // Send what it can first, so that resetting loses as little as possible.
    await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 4000))]);
    const n = dirtyCount();
    $('confirm-title').textContent = 'Reset your PIN?';
    $('confirm-text').textContent = (n ? `${n} items on this device have not synced yet and will be lost. ` : '')
      + 'This disconnects the device. Your Google Sheet keeps everything that has synced. To reconnect, use the setup code from your other device, then choose a new PIN.';
    $('confirm-no').textContent = 'Go back';
    $('confirm-yes').textContent = 'Reset and disconnect';
    $('confirm').showModal();
  });
  $('btn-lock').addEventListener('click', () => showLock('unlock'));
  $('btn-pin').addEventListener('click', () => showLock('current', true));
  ['pointerdown', 'keydown'].forEach((type) => document.addEventListener(type, () => {
    if (!isLocked() && state.config) touch();
  }, { passive: true }));
  setInterval(() => { if (document.visibilityState === 'visible') checkIdle(); }, 15000);

  document.querySelector('#view-add .keys').addEventListener('click', (ev) => {
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
    ev.target.blur();
    renderDate();
  });
  // Touch screens open the date picker on tap. With a mouse, a browser may only
  // open it from its small calendar icon, so open it from anywhere on the field.
  ['entry-date', 'edit-date'].forEach((id) => {
    $(id).addEventListener('click', (ev) => {
      if (!matchMedia('(pointer: fine)').matches || !ev.target.showPicker) return;
      try { ev.target.showPicker(); } catch (err) { /* the field still accepts typing */ }
    });
  });
  $('edit-book').addEventListener('change', (ev) => {
    const list = catsFor(ev.target.value);
    const current = $('edit-category').value;
    fillSelect($('edit-category'), list, list.includes(current) ? current : list[0]);
    fillSubs('');
  });
  $('edit-category').addEventListener('change', () => fillSubs(''));
  $('edit-add-label').addEventListener('click', addLabelFromEdit);
  $('edit-new-label').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); addLabelFromEdit(); }
  });
  $('setup-code').addEventListener('input', prefillName);
  $('m-people').addEventListener('toggle', () => { if ($('m-people').open) loadPeople(); });
  $('person-form').addEventListener('submit', submitPerson);
  $('person-cancel').addEventListener('click', () => $('person-edit').close());
  $('code-done').addEventListener('click', () => { $('code-text').value = ''; $('person-code').close(); });
  $('code-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('code-text').value);
      $('code-copy').textContent = 'Copied';
    } catch (err) {
      $('code-text').select();
    }
  });
  document.querySelectorAll('#theme-switch button').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem('kharcha-theme', b.dataset.choice); } catch (err) { /* lasts until reload */ }
    applyTheme(b.dataset.choice);
  }));
  padRefresh = wireItemSearch($('pad-name'), $('pad-results'), () => ({
    book: state.book,
    exclude: state.cart.map((i) => i.name),
    selected: state.cart.length,
    onPick: pickDraftItem,
  }));
  editRefresh = wireItemSearch($('edit-item'), $('edit-results'), () => ({
    book: $('edit-book').value,
    onPick: (item) => {
      // The field can hold several names; the search works on the last one.
      const before = $('edit-item').value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, -1);
      const typedOnly = !$('edit-item').value.includes(',');
      $('edit-item').value = [...before, item.name].join(', ');
      if (typedOnly && item.category) {
        const list = catsFor($('edit-book').value);
        fillSelect($('edit-category'), list, item.category);
        fillSubs(item.sub || '');
        ensureLists($('edit-book').value, item.category, item.sub);
      }
      closeResults($('edit-results'));
    },
  }));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => fitResults($('pad-results')));
  // Tapping anywhere else closes the results, so they never cover what was tapped.
  document.addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('#pad-results, #pad-name, #item-edit')) closeResults($('pad-results'));
  });
  wireItemSearch($('due-name'), $('due-results'), () => ({
    book: $('due-book').value,
    onPick: (item) => {
      $('due-name').value = item.name;
      fillDueCats(item.category || 'Other', item.sub || '');
      closeResults($('due-results'));
    },
  }));
  $('due-add').addEventListener('click', () => openDueEdit(null));
  $('due-form').addEventListener('submit', submitDue);
  $('due-cancel').addEventListener('click', () => $('due-edit').close());
  $('due-delete').addEventListener('click', () => {
    const l = dueDraft;
    $('due-edit').close();
    removeListItem(state.lists.find((x) => x.id === l.id));
  });
  $('due-varies').addEventListener('change', syncDueFields);
  $('due-every').addEventListener('change', syncDueFields);
  $('due-book').addEventListener('change', () => fillDueCats($('due-cat').value, ''));
  $('due-cat').addEventListener('change', () => fillDueSubs(''));
  $('pay-form').addEventListener('submit', submitPay);
  $('pay-cancel').addEventListener('click', () => $('due-pay').close());
  $('m-reminders').addEventListener('toggle', () => { if ($('m-reminders').open) loadReminders(); });
  $('rem-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (await saveReminders()) toast('Reminders saved');
  });
  $('rem-test').addEventListener('click', async () => {
    if (!(await saveReminders())) return;
    try {
      // The address must reach the Sheet before the test can use it.
      for (let i = 0; i < 100 && (state.sync.busy || state.lists.some((l) => l.dirty)); i++) {
        if (!state.sync.busy) await syncNow();
        else await new Promise((r) => setTimeout(r, 200));
      }
      await backendCall({ op: 'testReminder' });
      toast('Test email sent');
    } catch (err) {
      toast(err.code === 'no_reminder_address' ? 'Enter an email address first.' : 'Sending needs an internet connection and the latest backend.');
    }
  });
  $('item-form').addEventListener('submit', submitItemEdit);
  $('item-cancel').addEventListener('click', () => $('item-edit').close());
  $('item-cat').addEventListener('change', () => fillItemSubs(itemDraft.book));
  $('item-sub').addEventListener('change', () => { $('item-newsub-field').hidden = $('item-sub').value !== '__new'; });
  $('btn-accounts').addEventListener('click', openAccounts);
  $('pin-accounts').addEventListener('click', openAccounts);
  $('accounts-add').addEventListener('click', addProfile);
  $('accounts-close').addEventListener('click', () => $('accounts').close());
  $('setup-cancel').addEventListener('click', async () => {
    db.handle.close();
    await device.remove(profileDb(state.profileId));
    await device.set('active', state.profiles[0].id);
    location.reload();
  });
  $('via-cell').addEventListener('click', () => {
    if (currentVia()) openViaPicker();
    else { go('settings'); $('m-pay').open = true; }
  });
  $('cat-close').addEventListener('click', () => $('cat-picker').close());
  $('save').addEventListener('click', logExpense);
  $('total-row').addEventListener('click', () => {
    state.target = null;
    if (!state.amount) state.amount = '';
    renderCartLines();
    renderPad();
  });
  $('edit-next').addEventListener('click', () => {
    state.editNext = true;
    $('edit-form').requestSubmit();
  });
  $('edit-delete-order').addEventListener('click', () => {
    const e = state.entries.find((x) => x.id === editingId);
    $('edit').close();
    if (e) removeOrder(e.orderId);
  });
  ['pad-file'].forEach((id) => {
    $(id).addEventListener('change', async (ev) => {
      const files = [...ev.target.files];
      ev.target.value = '';
      if (files.length) await addDraftFiles(files);
    });
  });
  $('via-close').addEventListener('click', () => $('via-picker').close());
  $('via-manage').addEventListener('click', () => {
    $('via-picker').close();
    go('settings');
    $('m-pay').open = true;
  });
  $('list-form').addEventListener('submit', submitListEdit);
  $('list-cancel').addEventListener('click', () => $('list-edit').close());

  ['pick-file'].forEach((id) => {
    $(id).addEventListener('change', async (ev) => {
      const files = [...ev.target.files];
      ev.target.value = '';
      if (files.length) await attachFiles(files);
    });
  });
  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer').addEventListener('close', closeViewer);
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
    state.lists = state.lists.filter((l) => l.dirty);
    await db.setMeta('lists', state.lists);
    await db.setMeta('listCursor', 0);
    state.entries = keep;
    await syncNow();
    toast('Reloaded from the Sheet');
  });

  $('btn-disconnect').addEventListener('click', () => {
    const n = dirtyCount();
    $('confirm-title').textContent = 'Disconnect this device?';
    $('confirm-no').textContent = 'Keep connected';
    $('confirm-yes').textContent = 'Disconnect';
    $('confirm-text').textContent = n
      ? `${n} items on this device have not synced yet and will be lost. Your Google Sheet keeps everything else.`
      : 'Your expenses stay safe in the Google Sheet. You will need the setup code to reconnect.';
    $('confirm').showModal();
  });
  $('confirm-no').addEventListener('click', () => $('confirm').close());
  $('confirm-yes').addEventListener('click', async () => {
    await dropProfile();
  });

  // Physical keyboards on laptops and tablets
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (isLocked() && !$('confirm').open && !$('accounts').open) {
      if (/^[0-9]$/.test(ev.key)) { pinPress(ev.key); ev.preventDefault(); }
      else if (ev.key === 'Backspace') { pinPress('back'); ev.preventDefault(); }
      return;
    }
    if (ev.target.closest('input, select, textarea, dialog') || $('app').hidden) return;
    if (/^[0-9.]$/.test(ev.key)) { pressKey(ev.key); ev.preventDefault(); }
    else if (ev.key === 'Backspace') { pressKey('back'); ev.preventDefault(); }
  });

  // Sync whenever the app comes back or the connection returns.
  window.addEventListener('online', syncNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // A trip to the camera or file picker must not lose the date already chosen.
      if (Date.now() - (state.hiddenAt || 0) > 60000) state.date = null;
      checkIdle();
      renderAll();
      syncNow();
    } else {
      state.hiddenAt = Date.now();
      if (!isLocked() && state.config) touch();
    }
  });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, POLL_MS);
}

function prefillName() {
  const code = decodeCode($('setup-code').value);
  if (code && code.name) $('setup-name').value = code.name;
}

function readSetupLink() {
  const hash = location.hash.match(/^#setup=(.+)$/);
  if (!hash) return;
  if (!state.config) {
    setupMode(false);
    $('setup-code').value = decodeURIComponent(hash[1]);
    prefillName();
  }
  // A setup code works like a password, so it does not stay in the address bar.
  history.replaceState(null, '', location.pathname);
}

async function start() {
  loadTheme();
  wire_();
  await device.open();
  state.profiles = (await device.get('profiles')) || [];
  state.profileId = (await device.get('active')) || 'default';
  await db.open(profileDb(state.profileId));
  state.payDefaults = (await db.getMeta('payDefaults')) || {};
  const [config, settings, people, viaByBook, last, book, pinRec, fails, fileQueue, lists] = await Promise.all(
    ['config', 'settings', 'people', 'viaByBook', 'lastSync', 'book', 'pin', 'pinFails', 'fileQueue', 'lists'].map((k) => db.getMeta(k)));
  state.viaByBook = viaByBook || {};
  state.lists = lists || [];
  state.fileQueue = fileQueue || [];
  state.pinRec = pinRec || null;
  if (fails) { pinState.fails = fails.fails || 0; pinState.until = fails.until || 0; }
  document.body.dataset.book = book || 'Home';
  if (book) state.book = book;
  if (settings) state.settings = settings;
  if (people) state.people = people;
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
    $('setup-cancel').hidden = !state.profiles.length;
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

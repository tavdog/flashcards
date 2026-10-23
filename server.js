const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  console.error(`Flash Cards requires Node.js 18 or newer (found ${process.version}).`);
  console.error('Install a newer Node without root, e.g.: https://github.com/nvm-sh/nvm');
  process.exit(1);
}

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const APP_DIR = __dirname;
const DB_PATH = process.env.DB_PATH || path.join(APP_DIR, 'cards.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(APP_DIR, 'uploads');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
// Serve the app under a subpath (e.g. BASE_PATH=/flashcards) when the reverse
// proxy can't be configured to strip a prefix. Empty means root.
const BASE_PATH = ('/' + (process.env.BASE_PATH || '').replace(/^\/+|\/+$/g, '')).replace(/\/$/, '');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function reopenDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
}

function runMigrations() {
db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    image TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Migrate older DBs where image was NOT NULL
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(cards)').all();
  const imageCol = cols.find((c) => c.name === 'image');
  if (imageCol && imageCol.notnull === 1) {
    db.exec(`
      ALTER TABLE cards RENAME TO cards_old;
      CREATE TABLE cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        image TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO cards (id, name, image, created_at) SELECT id, name, image, created_at FROM cards_old;
      DROP TABLE cards_old;
    `);
  }
})();

// Add user_id to cards if missing (existing installs)
(function addUserId() {
  const cols = db.prepare('PRAGMA table_info(cards)').all();
  if (!cols.find((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE cards ADD COLUMN user_id INTEGER');
  }
})();

// Add deck_id to cards if missing (existing installs)
(function addDeckId() {
  const cols = db.prepare('PRAGMA table_info(cards)').all();
  if (!cols.find((c) => c.name === 'deck_id')) {
    db.exec('ALTER TABLE cards ADD COLUMN deck_id INTEGER');
  }
})();

// Add front/back flash-card fields if missing (existing installs)
(function addCardSides() {
  const cols = db.prepare('PRAGMA table_info(cards)').all();
  if (!cols.find((c) => c.name === 'answer')) {
    db.exec('ALTER TABLE cards ADD COLUMN answer TEXT');
  }
  if (!cols.find((c) => c.name === 'image_back')) {
    db.exec('ALTER TABLE cards ADD COLUMN image_back TEXT');
  }
})();

// Add tags to cards if missing (existing installs)
(function addTags() {
  const cols = db.prepare('PRAGMA table_info(cards)').all();
  if (!cols.find((c) => c.name === 'tags')) {
    db.exec('ALTER TABLE cards ADD COLUMN tags TEXT');
  }
})();

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    is_public INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Backfill: every existing user gets a Default deck, and any of their cards
// that have no deck_id are moved into it.
(function backfillDecks() {
  const users = db.prepare('SELECT id FROM users').all();
  for (const u of users) {
    let deck = db.prepare('SELECT id FROM decks WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(u.id);
    if (!deck) {
      deck = { id: db.prepare('INSERT INTO decks (name, user_id, is_public) VALUES (?, ?, 0)').run('Default', u.id).lastInsertRowid };
    }
    db.prepare('UPDATE cards SET deck_id = ? WHERE user_id = ? AND deck_id IS NULL').run(deck.id, u.id);
  }
})();

// Admin: is_admin column, and the first registered user is the admin
(function addIsAdmin() {
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (!cols.find((c) => c.name === 'is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  }
  const hasAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (!hasAdmin) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)').run();
  }
})();
}

runMigrations();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  }
});

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/tiff': '.tiff'
};

const UA = 'FlashCards/1.0 (personal flash card app)';

function cleanName(raw) {
  return raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

function searchQuery(raw) {
  return raw.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Tags are stored as a JSON array string. Input is comma-separated free text.
function normalizeTags(raw) {
  if (Array.isArray(raw)) raw = raw.join(',');
  if (typeof raw !== 'string') return [];
  const seen = new Set();
  for (const part of raw.split(',')) {
    const t = part.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
    if (t) seen.add(t);
  }
  return [...seen].slice(0, 20);
}

function parseTags(str) {
  if (!str) return [];
  try {
    const arr = JSON.parse(str);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function searchImages(query) {
  try {
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      generator: 'search',
      gsrsearch: query + ' filetype:bitmap',
      gsrnamespace: '6',
      gsrlimit: '10',
      prop: 'imageinfo',
      iiprop: 'url|mime',
      iiurlwidth: '600'
    });
    const res = await fetch('https://commons.wikimedia.org/w/api.php?' + params.toString(), {
      headers: { 'User-Agent': UA }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const pages = (data.query && data.query.pages) || {};
    const out = [];
    for (const k in pages) {
      const ii = pages[k].imageinfo && pages[k].imageinfo[0];
      if (ii && ii.mime && ii.mime.startsWith('image/')) {
        out.push({ url: ii.thumburl || ii.url, mime: ii.mime });
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function downloadImage(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    const ext = MIME_EXT[contentType] || '.jpg';
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
    stripImageMetadata(path.join(UPLOAD_DIR, filename));
    return filename;
  } catch (e) {
    return null;
  }
}

// Strip privacy-sensitive metadata (EXIF/GPS, XMP, comments) from images.
// Photos taken on phones carry GPS coordinates in EXIF; we remove all APPn
// segments from JPEG, eXIf/text chunks from PNG, and EXIF/XMP chunks from WebP
// without re-encoding pixels. All parsers fail-safe: unknown or malformed data
// returns null and the original file is left untouched.

function stripJpegMetadata(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out = [0xff, 0xd8];
  let i = 2;
  const n = buf.length;
  while (i < n) {
    if (buf[i] !== 0xff) return null;
    while (i < n && buf[i] === 0xff) i++;
    if (i >= n) return null;
    const marker = buf[i++];
    if (marker === 0xd9) { // EOI
      out.push(0xff, 0xd9);
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // no payload
      out.push(0xff, marker);
      continue;
    }
    if (i + 2 > n) return null;
    const len = (buf[i] << 8) | buf[i + 1];
    if (len < 2 || i + len > n) return null;
    if (marker === 0xda) { // SOS: copy header then entropy-coded data verbatim
      out.push(0xff, marker);
      for (let k = i; k < n; k++) out.push(buf[k]);
      break;
    }
    const isMeta = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe; // APPn/COM
    if (!isMeta) {
      out.push(0xff, marker);
      for (let k = i; k < i + len; k++) out.push(buf[k]);
    }
    i += len;
  }
  return Buffer.from(out);
}

function stripPngMetadata(buf) {
  if (buf.length < 57) return null;
  for (let k = 0; k < 8; k++) {
    if (buf[k] !== [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][k]) return null;
  }
  const out = [];
  for (let k = 0; k < 8; k++) out.push(buf[k]); // keep PNG signature
  let i = 8; // skip PNG signature
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const total = 12 + len;
    if (len > 0x7fffffff || i + total > buf.length) return null;
    if (type === 'IHDR' && out.length === 0) {
      for (let k = i; k < i + total; k++) out.push(buf[k]);
    } else if (type !== 'eXIf' && type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') {
      for (let k = i; k < i + total; k++) out.push(buf[k]);
    }
    i += total;
    if (type === 'IEND') break;
  }
  return out.length ? Buffer.from(out) : null;
}

function stripWebpMetadata(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const out = [];
  for (let k = 0; k < 12; k++) out.push(buf[k]); // keep RIFF/WEBP header
  let i = 12;
  while (i + 8 <= buf.length) {
    const type = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const padded = size + (size & 1);
    if (i + 8 + size > buf.length) return null;
    if (type !== 'EXIF' && type !== 'XMP ') {
      for (let k = i; k < i + 8 + size; k++) out.push(buf[k]);
    }
    i += 8 + padded;
  }
  return out.length ? Buffer.from(out) : null;
}

function stripMetadataBuffer(buf) {
  if (!buf || !buf.length) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return stripJpegMetadata(buf);
  if (buf[0] === 0x89 && buf[1] === 0x50) return stripPngMetadata(buf);
  if (buf.toString('latin1', 0, 4) === 'RIFF') return stripWebpMetadata(buf);
  return null;
}

function stripImageMetadata(filePath) {
  try {
    const before = fs.readFileSync(filePath);
    const stripped = stripMetadataBuffer(before);
    // Only rewrite when we positively removed bytes; never risk corrupting a file.
    if (stripped && stripped.length > 0 && stripped.length < before.length) {
      fs.writeFileSync(filePath, stripped);
      return true;
    }
  } catch (e) {}
  return false;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    let val = part.slice(idx + 1).trim();
    try { val = decodeURIComponent(val); } catch (e) {}
    out[key] = val;
  }
  return out;
}

const SESSION_DAYS = 30;
const COOKIE_PATH = BASE_PATH || '/';
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`);
  return token;
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0`);
}

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.sid;
  if (!token) return null;
  const sess = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!sess || new Date(sess.expires_at) <= new Date()) return null;
  return db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(sess.user_id) || null;
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (!user.is_admin) return res.status(403).json({ error: 'Admin access required' });
  req.user = user;
  next();
}

function getDeckAccess(deckId, userId) {
  const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(deckId);
  if (!deck) return null;
  return { deck, isOwner: deck.user_id === userId };
}

function copyImageFile(srcFilename) {
  if (!srcFilename) return null;
  const src = path.join(UPLOAD_DIR, srcFilename);
  if (!fs.existsSync(src)) return null;
  const ext = path.extname(srcFilename).toLowerCase() || '.jpg';
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.copyFileSync(src, path.join(UPLOAD_DIR, filename));
  return filename;
}

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));
app.use('/uploads', requireAuth, express.static(UPLOAD_DIR));

app.post('/api/register', (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!/^[a-z0-9_-]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters (letters, numbers, _ or -)' });
  }
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const isFirst = db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
  const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hashPassword(password));
  const userId = info.lastInsertRowid;

  const deckId = db.prepare('INSERT INTO decks (name, user_id, is_public) VALUES (?, ?, 0)').run('Default', userId).lastInsertRowid;

  if (isFirst) {
    db.prepare('UPDATE cards SET user_id = ?, deck_id = ? WHERE user_id IS NULL').run(userId, deckId);
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
  }

  startSession(res, userId);
  res.status(201).json({ user: { id: userId, username, is_admin: isFirst ? 1 : 0 } });
});

app.post('/api/login', (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT id, username, password, is_admin FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  startSession(res, user.id);
  res.json({ user: { id: user.id, username: user.username, is_admin: user.is_admin } });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies.sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: getSessionUser(req) });
});

// Streams a consistent snapshot (SQLite backup API) of the DB plus all uploads.
app.get('/api/admin/backup', requireAdmin, async (req, res) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-backup-'));
  const cleanup = () => fs.rm(tmp, { recursive: true, force: true }, () => {});
  try {
    await db.backup(path.join(tmp, 'cards.db'));
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.symlinkSync(UPLOAD_DIR, path.join(tmp, 'uploads'), 'dir');
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="flashcards-backup-${stamp}.tar.gz"`);
    const tar = spawn('tar', ['-czhf', '-', '-C', tmp, 'cards.db', 'uploads']);
    tar.stdout.pipe(res);
    tar.stderr.on('data', (d) => console.error('backup tar:', d.toString().trim()));
    tar.on('close', (code) => {
      cleanup();
      if (code !== 0 && !res.headersSent) res.status(500).end();
    });
    tar.on('error', (e) => {
      cleanup();
      console.error('backup tar failed:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Backup failed: tar unavailable' });
    });
  } catch (e) {
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// Restores a backup produced by /api/admin/backup (.tar.gz) or a bare .db file.
const restoreUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 1024 * 1024 * 1024 } });

app.post('/api/admin/restore', requireAdmin, restoreUpload.single('backup'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No backup file uploaded' });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-restore-'));
  const cleanup = () => {
    fs.rm(file.path, { force: true }, () => {});
    fs.rm(work, { recursive: true, force: true }, () => {});
  };
  let closed = false;
  try {
    const name = (file.originalname || '').toLowerCase();
    let dbFile = null;
    let uploadsDir = null;

    if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) {
      const members = execFileSync('tar', ['-tzf', file.path], { encoding: 'utf8' })
        .split('\n').map((m) => m.trim()).filter(Boolean);
      const unsafe = members.find((m) => m.startsWith('/') || m.split('/').includes('..'));
      if (unsafe) throw new Error('Archive contains an unsafe path: ' + unsafe);
      execFileSync('tar', ['-xzf', file.path, '-C', work]);
      if (fs.existsSync(path.join(work, 'cards.db'))) dbFile = path.join(work, 'cards.db');
      if (fs.existsSync(path.join(work, 'uploads'))) uploadsDir = path.join(work, 'uploads');
    } else if (name.endsWith('.db')) {
      dbFile = file.path;
    } else {
      throw new Error('Upload a .tar.gz backup or a .db file');
    }
    if (!dbFile) throw new Error('No cards.db found in the archive');

    const check = new Database(dbFile, { readonly: true });
    try {
      const integrity = check.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new Error('Backup failed integrity check: ' + integrity);
      const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      for (const t of ['users', 'cards', 'decks']) {
        if (!tables.includes(t)) throw new Error('Backup is missing the "' + t + '" table');
      }
    } finally {
      check.close();
    }

    const safety = `${DB_PATH}.pre-restore-${Date.now()}`;
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    closed = true;
    fs.copyFileSync(DB_PATH, safety);
    fs.copyFileSync(dbFile, DB_PATH);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
    reopenDb();
    closed = false;
    runMigrations();

    if (uploadsDir) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      fs.cpSync(uploadsDir, UPLOAD_DIR, { recursive: true, force: true });
    }

    const stats = {
      users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      cards: db.prepare('SELECT COUNT(*) AS n FROM cards').get().n,
      uploads: fs.readdirSync(UPLOAD_DIR).length
    };
    cleanup();
    res.json({ ok: true, safetyCopy: path.basename(safety), ...stats });
  } catch (e) {
    if (closed) { try { reopenDb(); } catch (err) {} }
    cleanup();
    if (!res.headersSent) res.status(400).json({ error: e.message });
  }
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.created_at, u.is_admin,
      (SELECT COUNT(*) FROM decks d WHERE d.user_id = u.id) AS deck_count,
      (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id) AS card_count
    FROM users u
    ORDER BY u.id ASC
  `).all();
  res.json(users);
});

app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const password = req.body.password || '';
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password), target.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id); // force re-login
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account here' });
  }
  db.transaction(() => {
    const decks = db.prepare('SELECT id FROM decks WHERE user_id = ?').all(target.id);
    for (const d of decks) {
      const cards = db.prepare('SELECT image, image_back FROM cards WHERE deck_id = ?').all(d.id);
      for (const c of cards) {
        if (c.image) fs.unlink(path.join(UPLOAD_DIR, c.image), () => {});
        if (c.image_back) fs.unlink(path.join(UPLOAD_DIR, c.image_back), () => {});
      }
      db.prepare('DELETE FROM cards WHERE deck_id = ?').run(d.id);
    }
    db.prepare('DELETE FROM decks WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  })();
  res.json({ ok: true });
});

app.get('/api/decks', requireAuth, (req, res) => {
  const decks = db.prepare(`
    SELECT d.id, d.name, d.is_public, d.created_at,
      (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id) AS card_count
    FROM decks d WHERE d.user_id = ?
    ORDER BY d.id ASC
  `).all(req.user.id);
  res.json(decks);
});

app.post('/api/decks', requireAuth, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Deck name is required' });
  const isPublic = req.body.is_public ? 1 : 0;
  const info = db.prepare('INSERT INTO decks (name, user_id, is_public) VALUES (?, ?, ?)').run(name, req.user.id, isPublic);
  const deck = db.prepare('SELECT id, name, is_public, created_at FROM decks WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(deck);
});

app.put('/api/decks/:id', requireAuth, (req, res) => {
  const access = getDeckAccess(req.params.id, req.user.id);
  if (!access || !access.isOwner) return res.status(404).json({ error: 'Deck not found' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Deck name is required' });
  const isPublic = req.body.is_public ? 1 : 0;
  db.prepare('UPDATE decks SET name = ?, is_public = ? WHERE id = ?').run(name, isPublic, req.params.id);
  const deck = db.prepare('SELECT id, name, is_public, created_at FROM decks WHERE id = ?').get(req.params.id);
  res.json(deck);
});

app.delete('/api/decks/:id', requireAuth, (req, res) => {
  const access = getDeckAccess(req.params.id, req.user.id);
  if (!access || !access.isOwner) return res.status(404).json({ error: 'Deck not found' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM decks WHERE user_id = ?').get(req.user.id).c;
  if (count <= 1) return res.status(400).json({ error: 'You must keep at least one deck' });
  const cards = db.prepare('SELECT id, image, image_back FROM cards WHERE deck_id = ?').all(req.params.id);
  db.prepare('DELETE FROM cards WHERE deck_id = ?').run(req.params.id);
  db.prepare('DELETE FROM decks WHERE id = ?').run(req.params.id);
  for (const c of cards) {
    if (c.image) fs.unlink(path.join(UPLOAD_DIR, c.image), () => {});
    if (c.image_back) fs.unlink(path.join(UPLOAD_DIR, c.image_back), () => {});
  }
  res.json({ ok: true });
});

app.get('/api/public-decks', requireAuth, (req, res) => {
  const decks = db.prepare(`
    SELECT d.id, d.name, d.user_id, d.created_at, u.username AS owner,
      (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id) AS card_count
    FROM decks d JOIN users u ON u.id = d.user_id
    WHERE d.is_public = 1
    ORDER BY d.id DESC
  `).all();
  const out = decks.map((d) => ({
    id: d.id,
    name: d.name,
    owner: d.owner,
    card_count: d.card_count,
    created_at: d.created_at,
    is_owner: d.user_id === req.user.id
  }));
  res.json(out);
});

app.post('/api/decks/:id/copy', requireAuth, (req, res) => {
  const access = getDeckAccess(req.params.id, req.user.id);
  if (!access || access.isOwner || !access.deck.is_public) {
    return res.status(404).json({ error: 'Deck not found' });
  }
  const info = db.prepare('INSERT INTO decks (name, user_id, is_public) VALUES (?, ?, 0)').run(access.deck.name, req.user.id);
  const newDeckId = info.lastInsertRowid;
  const cards = db.prepare('SELECT name, answer, tags, image, image_back FROM cards WHERE deck_id = ?').all(access.deck.id);
  for (const c of cards) {
    const image = copyImageFile(c.image);
    const imageBack = copyImageFile(c.image_back);
    db.prepare('INSERT INTO cards (name, answer, tags, image, image_back, user_id, deck_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(c.name, c.answer, c.tags, image, imageBack, req.user.id, newDeckId);
  }
  const deck = db.prepare('SELECT id, name, is_public, created_at FROM decks WHERE id = ?').get(newDeckId);
  res.status(201).json(deck);
});

app.get('/api/cards', requireAuth, (req, res) => {
  const deckId = Number(req.query.deck_id);
  if (!deckId) return res.status(400).json({ error: 'deck_id is required' });
  const access = getDeckAccess(deckId, req.user.id);
  if (!access || (!access.isOwner && !access.deck.is_public)) {
    return res.status(404).json({ error: 'Deck not found' });
  }
  const order = req.query.order === 'random' ? 'ORDER BY RANDOM()' : 'ORDER BY id ASC';
  const cards = db.prepare(`SELECT id, name, answer, tags, image, image_back, created_at FROM cards WHERE deck_id = ? ${order}`).all(deckId);
  for (const c of cards) c.tags = parseTags(c.tags);
  res.json(cards);
});

app.get('/api/suggest-image', requireAuth, async (req, res) => {
  const q = searchQuery(req.query.q || '');
  if (!q) return res.json({ query: q, images: [] });
  const images = await searchImages(q);
  res.json({ query: q, images: images.slice(0, 6) });
});

app.post('/api/cards', requireAuth, (req, res) => {
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'image_back', maxCount: 1 }])(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      const rawName = (req.body.name || '').trim();
      const name = cleanName(rawName);
      if (!name) return res.status(400).json({ error: 'Name is required' });

      const answer = (req.body.answer || '').trim();

      const deckId = Number(req.body.deck_id);
      if (!deckId) return res.status(400).json({ error: 'deck_id is required' });
      const access = getDeckAccess(deckId, req.user.id);
      if (!access || !access.isOwner) return res.status(404).json({ error: 'Deck not found' });

      let image = null;
      let imageSource = 'none';
      if (req.files && req.files.image && req.files.image[0]) {
        image = req.files.image[0].filename;
        stripImageMetadata(path.join(UPLOAD_DIR, image));
        imageSource = 'upload';
      } else {
        const url = (req.body.suggest_url || '').trim();
        if (url) {
          const filename = await downloadImage(url);
          if (filename) {
            image = filename;
            imageSource = 'suggested';
          }
        }
      }

      const imageBack = (req.files && req.files.image_back && req.files.image_back[0]) ? req.files.image_back[0].filename : null;
      if (imageBack) stripImageMetadata(path.join(UPLOAD_DIR, imageBack));

      const tags = JSON.stringify(normalizeTags(req.body.tags));

      const info = db.prepare('INSERT INTO cards (name, answer, tags, image, image_back, user_id, deck_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(name, answer, tags, image, imageBack, req.user.id, deckId);
      const card = db.prepare('SELECT id, name, answer, tags, image, image_back, created_at FROM cards WHERE id = ?').get(info.lastInsertRowid);
      card.tags = parseTags(card.tags);
      card.image_source = imageSource;
      res.status(201).json(card);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.put('/api/cards/:id', requireAuth, (req, res) => {
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'image_back', maxCount: 1 }])(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      const existing = db.prepare('SELECT id, name, answer, tags, image, image_back FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
      if (!existing) return res.status(404).json({ error: 'Card not found' });

      const rawName = (req.body.name || '').trim();
      const name = cleanName(rawName);
      if (!name) return res.status(400).json({ error: 'Name is required' });

      const answer = (req.body.answer || '').trim();

      let image = existing.image;
      let imageSource = 'unchanged';

      if (req.files && req.files.image && req.files.image[0]) {
        if (existing.image) fs.unlink(path.join(UPLOAD_DIR, existing.image), () => {});
        image = req.files.image[0].filename;
        stripImageMetadata(path.join(UPLOAD_DIR, image));
        imageSource = 'upload';
      } else {
        const url = (req.body.suggest_url || '').trim();
        if (url) {
          const filename = await downloadImage(url);
          if (filename) {
            if (existing.image) fs.unlink(path.join(UPLOAD_DIR, existing.image), () => {});
            image = filename;
            imageSource = 'suggested';
          }
        } else if (req.body.remove_image === 'true') {
          if (existing.image) fs.unlink(path.join(UPLOAD_DIR, existing.image), () => {});
          image = null;
          imageSource = 'removed';
        }
      }

      let imageBack = existing.image_back;
      if (req.files && req.files.image_back && req.files.image_back[0]) {
        if (existing.image_back) fs.unlink(path.join(UPLOAD_DIR, existing.image_back), () => {});
        imageBack = req.files.image_back[0].filename;
        stripImageMetadata(path.join(UPLOAD_DIR, imageBack));
      } else if (req.body.remove_image_back === 'true') {
        if (existing.image_back) fs.unlink(path.join(UPLOAD_DIR, existing.image_back), () => {});
        imageBack = null;
      }

      if (req.body.swap_images === 'true') {
        const tmp = image;
        image = imageBack;
        imageBack = tmp;
      }

      const tags = req.body.tags === undefined
        ? String(existing.tags || '[]')
        : JSON.stringify(normalizeTags(req.body.tags));

      db.prepare('UPDATE cards SET name = ?, answer = ?, tags = ?, image = ?, image_back = ? WHERE id = ? AND user_id = ?').run(name, answer, tags, image, imageBack, req.params.id, req.user.id);
      const card = db.prepare('SELECT id, name, answer, tags, image, image_back, created_at FROM cards WHERE id = ?').get(req.params.id);
      card.tags = parseTags(card.tags);
      card.image_source = imageSource;
      res.json(card);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.delete('/api/cards/:id', requireAuth, (req, res) => {
  const card = db.prepare('SELECT id, name, image, image_back FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  db.prepare('DELETE FROM cards WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (card.image) fs.unlink(path.join(UPLOAD_DIR, card.image), () => {});
  if (card.image_back) fs.unlink(path.join(UPLOAD_DIR, card.image_back), () => {});
  res.json({ ok: true });
});

app.post('/api/cards/:id/move', requireAuth, (req, res) => {
  const card = db.prepare('SELECT id, name, deck_id FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const deckId = Number(req.body.deck_id);
  if (!deckId) return res.status(400).json({ error: 'deck_id is required' });
  const access = getDeckAccess(deckId, req.user.id);
  if (!access || !access.isOwner) return res.status(404).json({ error: 'Deck not found' });
  db.prepare('UPDATE cards SET deck_id = ? WHERE id = ? AND user_id = ?').run(deckId, req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/cards/:id/copy', requireAuth, (req, res) => {
  const card = db.prepare('SELECT id, name, answer, tags, image, image_back FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const deckId = Number(req.body.deck_id);
  if (!deckId) return res.status(400).json({ error: 'deck_id is required' });
  const access = getDeckAccess(deckId, req.user.id);
  if (!access || !access.isOwner) return res.status(404).json({ error: 'Deck not found' });
  const image = copyImageFile(card.image);
  const imageBack = copyImageFile(card.image_back);
  const info = db.prepare('INSERT INTO cards (name, answer, tags, image, image_back, user_id, deck_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(card.name, card.answer, card.tags, image, imageBack, req.user.id, deckId);
  const newCard = db.prepare('SELECT id, name, answer, tags, image, image_back, created_at FROM cards WHERE id = ?').get(info.lastInsertRowid);
  newCard.tags = parseTags(newCard.tags);
  res.status(201).json(newCard);
});

app.get('/api/health', (req, res) => {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM cards').get();
  res.json({ ok: true, count: c });
});

let server = app;
if (BASE_PATH) {
  const outer = express();
  outer.get(BASE_PATH, (req, res, next) => {
    if (req.originalUrl !== BASE_PATH) return next();
    res.redirect(BASE_PATH + '/');
  });
  outer.use(BASE_PATH, app);
  server = outer;
}

server.listen(PORT, () => {
  console.log(`Flash Cards server running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Uploads: ${UPLOAD_DIR}`);
  console.log(`Base path: ${BASE_PATH || '/'}`);
});

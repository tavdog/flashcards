const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const APP_DIR = __dirname;
const DB_PATH = process.env.DB_PATH || path.join(APP_DIR, 'cards.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(APP_DIR, 'uploads');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
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
    return filename;
  } catch (e) {
    return null;
  }
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
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`);
  return token;
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.sid;
  if (!token) return null;
  const sess = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!sess || new Date(sess.expires_at) <= new Date()) return null;
  return db.prepare('SELECT id, username FROM users WHERE id = ?').get(sess.user_id) || null;
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
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
  }

  startSession(res, userId);
  res.status(201).json({ user: { id: userId, username } });
});

app.post('/api/login', (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT id, username, password FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  startSession(res, user.id);
  res.json({ user: { id: user.id, username: user.username } });
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
  const cards = db.prepare('SELECT id, image FROM cards WHERE deck_id = ?').all(req.params.id);
  db.prepare('DELETE FROM cards WHERE deck_id = ?').run(req.params.id);
  db.prepare('DELETE FROM decks WHERE id = ?').run(req.params.id);
  for (const c of cards) if (c.image) fs.unlink(path.join(UPLOAD_DIR, c.image), () => {});
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
  const cards = db.prepare('SELECT name, image FROM cards WHERE deck_id = ?').all(access.deck.id);
  for (const c of cards) {
    const image = copyImageFile(c.image);
    db.prepare('INSERT INTO cards (name, image, user_id, deck_id) VALUES (?, ?, ?, ?)').run(c.name, image, req.user.id, newDeckId);
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
  const cards = db.prepare(`SELECT id, name, image, created_at FROM cards WHERE deck_id = ? ${order}`).all(deckId);
  res.json(cards);
});

app.get('/api/suggest-image', requireAuth, async (req, res) => {
  const q = searchQuery(req.query.q || '');
  if (!q) return res.json({ query: q, images: [] });
  const images = await searchImages(q);
  res.json({ query: q, images: images.slice(0, 6) });
});

app.post('/api/cards', requireAuth, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      const rawName = (req.body.name || '').trim();
      const name = cleanName(rawName);
      if (!name) return res.status(400).json({ error: 'Name is required' });

      const deckId = Number(req.body.deck_id);
      if (!deckId) return res.status(400).json({ error: 'deck_id is required' });
      const access = getDeckAccess(deckId, req.user.id);
      if (!access || !access.isOwner) return res.status(404).json({ error: 'Deck not found' });

      let image = null;
      let imageSource = 'none';
      if (req.file) {
        image = req.file.filename;
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

      const info = db.prepare('INSERT INTO cards (name, image, user_id, deck_id) VALUES (?, ?, ?, ?)').run(name, image, req.user.id, deckId);
      const card = db.prepare('SELECT id, name, image, created_at FROM cards WHERE id = ?').get(info.lastInsertRowid);
      card.image_source = imageSource;
      res.status(201).json(card);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.put('/api/cards/:id', requireAuth, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      const existing = db.prepare('SELECT id, name, image FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
      if (!existing) return res.status(404).json({ error: 'Card not found' });

      const rawName = (req.body.name || '').trim();
      const name = cleanName(rawName);
      if (!name) return res.status(400).json({ error: 'Name is required' });

      let image = existing.image;
      let imageSource = 'unchanged';

      if (req.file) {
        if (existing.image) fs.unlink(path.join(UPLOAD_DIR, existing.image), () => {});
        image = req.file.filename;
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

      db.prepare('UPDATE cards SET name = ?, image = ? WHERE id = ? AND user_id = ?').run(name, image, req.params.id, req.user.id);
      const card = db.prepare('SELECT id, name, image, created_at FROM cards WHERE id = ?').get(req.params.id);
      card.image_source = imageSource;
      res.json(card);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.delete('/api/cards/:id', requireAuth, (req, res) => {
  const card = db.prepare('SELECT id, name, image FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  db.prepare('DELETE FROM cards WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (card.image) fs.unlink(path.join(UPLOAD_DIR, card.image), () => {});
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
  const card = db.prepare('SELECT id, name, image FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const deckId = Number(req.body.deck_id);
  if (!deckId) return res.status(400).json({ error: 'deck_id is required' });
  const access = getDeckAccess(deckId, req.user.id);
  if (!access || !access.isOwner) return res.status(404).json({ error: 'Deck not found' });
  const image = copyImageFile(card.image);
  const info = db.prepare('INSERT INTO cards (name, image, user_id, deck_id) VALUES (?, ?, ?, ?)').run(card.name, image, req.user.id, deckId);
  const newCard = db.prepare('SELECT id, name, image, created_at FROM cards WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(newCard);
});

app.get('/api/health', (req, res) => {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM cards').get();
  res.json({ ok: true, count: c });
});

app.listen(PORT, () => {
  console.log(`Flash Cards server running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Uploads: ${UPLOAD_DIR}`);
});

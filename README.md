# Flash Cards

A simple, self-hosted flash-card study app. Each card has a **front** (a name
plus an optional image) and a **back** (an answer plus an optional image). Type
in both sides when creating a card, then flip through your decks in order or
shuffled. Organize cards into multiple named decks, make decks public for others
to browse and copy, and move or copy individual cards between your own decks.

## Features

- **Accounts** — per-user login with salted scrypt password hashing and 30-day
  cookie sessions.
- **Cards** — each card has a front (name) and a back (answer), with an optional
  uploaded image on either side (or an automatically suggested front image from
  Wikimedia Commons). Edit or delete cards.
- **Tags** — add comma-separated tags to cards; filter the current deck by tag
  with one click, and get autocomplete suggestions from existing tags.
- **Privacy-safe uploads** — uploaded images are scanned for metadata
  (EXIF/GPS location, comments, XMP in JPEG, PNG, and WebP files) and it is
  stripped before storage, so photos taken on a phone never leak location data.
  Files that can't be parsed are left untouched rather than corrupted.
- **Decks** — keep cards in multiple named decks. Each deck can be **public** or
  **private**.
- **Sharing** — browse other users' public decks, view their cards, study them,
  and copy a whole deck into your own account.
- **Move / copy cards** — move or copy individual cards between your own decks;
  copied cards get a fresh copy of their image file.
- **Study mode** — sequential or shuffled, with left/right arrow navigation. The
  front is shown first; click the card (or press Space/Enter) to flip it and
  reveal the answer.

## Tech stack

- **Backend:** Node.js 18+, [Express](https://expressjs.com/) 4,
  [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), and
  [Multer](https://github.com/expressjs/multer) for uploads.
- **Frontend:** plain HTML, CSS, and vanilla JavaScript — no framework, no build step.
- **Storage:** SQLite (`cards.db`) in WAL mode, with images stored as files under
  `uploads/`.
- **Image search:** the [Wikimedia Commons API](https://commons.wikimedia.org/w/api.php).

## Getting started

```bash
npm install
npm start
```

The server listens on port `3000` by default and serves the app at
<http://localhost:3000>.

### Configuration

The app is configured entirely through environment variables:

| Variable     | Default      | Description                          |
| ------------ | ------------ | ------------------------------------ |
| `PORT`       | `3000`       | Port the HTTP server listens on      |
| `DB_PATH`    | `./cards.db` | Path to the SQLite database file     |
| `UPLOAD_DIR` | `./uploads`  | Directory where card images are kept |
| `BASE_PATH`  | *(empty)*    | Subpath to serve under, e.g. `/flashcards` |

## Deployment

Deploy straight from this repository into your home directory — no root access
and no system-wide paths are needed.

```bash
git clone https://github.com/tavdog/flashcards.git ~/flashcards
cd ~/flashcards
npm ci --omit=dev
BASE_PATH=/flashcards PORT=3000 npm start
```

The database and `uploads/` directory are created inside `~/flashcards` on
first run, so everything the app owns stays in that one directory. Nothing is
installed outside it — no global npm packages, no `/opt`, no `sudo`.

All configuration is via environment variables, so run it with whatever
supervisor your account has (a systemd user unit below, `tmux`, `nohup`, or a
container entrypoint).

### Node version

**Node.js 18 or newer is required.** Older releases (Node 12/14/16) can't build
the `better-sqlite3` native module, and `npm ci` will fail with compiler errors.
If the host only has an old Node, install a current one in your home directory
— no root needed:

```bash
# nvm (installs into ~/.nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 22 && nvm use 22

# or a plain tarball (installs into ~/.local/node)
mkdir -p ~/.local && cd ~/.local
curl -fsSLO https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz
tar -xf node-v22.11.0-linux-x64.tar.xz && mv node-v22.11.0-linux-x64 node
export PATH="$HOME/.local/node/bin:$PATH"
```

If you use systemd, point `ExecStart` at the absolute path of that interpreter
(user units don't read your shell profile), e.g.
`ExecStart=%h/.nvm/versions/node/v22.11.0/bin/node server.js`.

### Serving under a subpath

If you can't configure the reverse proxy to give the app its own hostname, set
`BASE_PATH` and point the existing proxy rule at the app. Everything — pages,
API routes, image URLs, and the session cookie — is then served under that
prefix:

```bash
BASE_PATH=/flashcards PORT=3000 npm start
# → https://example.com/flashcards/
```

`BASE_PATH=/flashcards` expects the proxy to forward the prefix unchanged
(`/flashcards/...` → `127.0.0.1:3000/flashcards/...`). Leave `BASE_PATH` unset
when the proxy strips the prefix or the app is served at the root.

### systemd (user unit, no root)

`~/.config/systemd/user/cards.service`:

```ini
[Unit]
Description=Flash Cards Web Server
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/flashcards
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=BASE_PATH=/flashcards

[Install]
WantedBy=default.target
```

```bash
mkdir -p ~/.config/systemd/user
systemctl --user daemon-reload
systemctl --user enable --now cards.service
loginctl enable-linger "$USER"   # keep it running after you log out
```

DB and uploads default to the working directory, so no extra paths are needed.
Without systemd at all, `nohup env BASE_PATH=/flashcards PORT=3000 node server.js &`
from `~/flashcards` works just as well.

### Reverse proxy

The bundled reference deployment runs behind Apache 2.4 with an HTTPS reverse
proxy to `127.0.0.1:3000`; nginx works the same way (`proxy_pass
http://127.0.0.1:3000;`). Allow uploads up to ~30 MB in the proxy
(`LimitRequestBody` / `client_max_body_size`), since images are capped at 25 MB.
Use an unprivileged port (1024+) so no root is required.

### Railway

The repo ships a `Dockerfile` and `railway.json`, so Railway builds and health
checks the app with no extra configuration.

1. **New Project → Deploy from GitHub repo** and pick `tavdog/flashcards`.
   Railway builds the Dockerfile and starts `node server.js`.
2. **Add a Volume** (service → Settings → Volumes) mounted at `/data`, then set:
   ```
   DB_PATH=/data/cards.db
   UPLOAD_DIR=/data/uploads
   ```
   Without a volume the container filesystem is ephemeral and every redeploy
   discards the database and images.
3. Leave `PORT` unset — Railway injects it — and leave `BASE_PATH` unset, since
   the service gets its own hostname.
4. Keep the service at **one replica**. SQLite and the uploads directory live on
   a single volume and aren't safe to share between instances.
5. `railway.json` points the health check at `/api/health`.

To back up, pull the volume contents periodically (`railway volume` commands in
the Railway CLI) or run `.backup` from a shell on the service; the files to
save are `/data/cards.db` and `/data/uploads`.

### Backups

The database runs in WAL mode, so copy it with SQLite's backup command rather
than `cp`:

```bash
sqlite3 ~/flashcards/cards.db ".backup ~/backups/cards-$(date +%F).db"
tar -czf ~/backups/uploads-$(date +%F).tar.gz -C ~/flashcards uploads
```

## API

| Method | Route                    | Description                                |
| ------ | ------------------------ | ------------------------------------------ |
| POST   | `/api/register`          | Create an account                          |
| POST   | `/api/login`             | Log in                                     |
| POST   | `/api/logout`            | Log out                                    |
| GET    | `/api/me`                | Current session user                        |
| GET    | `/api/decks`             | List your decks (with card counts)          |
| POST   | `/api/decks`             | Create a deck                               |
| PUT    | `/api/decks/:id`         | Rename / toggle a deck's visibility         |
| DELETE | `/api/decks/:id`         | Delete a deck and its cards                 |
| GET    | `/api/public-decks`      | List public decks                           |
| POST   | `/api/decks/:id/copy`    | Copy a public deck into your account        |
| GET    | `/api/cards?deck_id=X`   | List a deck's cards                         |
| POST   | `/api/cards`             | Add a card (name + answer, optional front/back images, tags) |
| PUT    | `/api/cards/:id`         | Edit a card (front/back/tags)               |
| DELETE | `/api/cards/:id`         | Delete a card                               |
| POST   | `/api/cards/:id/move`    | Move a card to another of your decks        |
| POST   | `/api/cards/:id/copy`    | Copy a card to another of your decks        |
| GET    | `/api/suggest-image?q=X` | Search Wikimedia Commons for a card image   |
| GET    | `/api/health`            | Health check                                |

All card/deck routes require authentication; owners can read/write their own
data, and public decks are readable (and copyable) by any signed-in user.

## Credits

Built with [Claude Code](https://claude.com/claude-code), Anthropic's AI coding
agent.

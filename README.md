# Flash Cards

A simple, self-hosted image flash-card study app. Upload an image and a name for
each card, then study your decks in order or shuffled. Organize cards into
multiple named decks, make decks public for others to browse and copy, and move
or copy individual cards between your own decks.

## Features

- **Accounts** — per-user login with salted scrypt password hashing and 30-day
  cookie sessions.
- **Cards** — add a name plus an uploaded image (or an automatically suggested
  image from Wikimedia Commons), edit, or delete cards.
- **Decks** — keep cards in multiple named decks. Each deck can be **public** or
  **private**.
- **Sharing** — browse other users' public decks, view their cards, study them,
  and copy a whole deck into your own account.
- **Move / copy cards** — move or copy individual cards between your own decks;
  copied cards get a fresh copy of their image file.
- **Study mode** — sequential or shuffled, with left/right arrow navigation.

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

## Deployment

The production setup runs the app behind Apache and keeps it alive with systemd:

- **Apache 2.4** reverse-proxies HTTPS traffic to `127.0.0.1:3000` (with an
  HTTP → HTTPS redirect).
- **systemd** service (`cards.service`) runs `node server.js` in the app
  directory with `PORT=3000` and restarts automatically on failure.

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
| POST   | `/api/cards`             | Add a card (name + image)                   |
| PUT    | `/api/cards/:id`         | Edit a card                                 |
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

# ⚡ Nightcode — Real-Time Collaborative Code Editor

Multiple people edit the same file together and see each other's changes and
cursors live. Built with Flask, Flask-SocketIO, and PostgreSQL.

## Features

- **Sign up / sign in** — email+password accounts (Werkzeug password hashing, Flask sessions —
  no third-party auth service). Creating or joining a room requires being signed in.
- **Scroll-driven landing page** — the "Nightcode" title (set in Dela Gothic One) starts
  centered and huge, then glides to a small top-right anchor as you scroll, with three
  step explainers fading in along the way. A final card appears at the bottom-left once
  you've scrolled to the end: Create/Join if you're signed in, Sign in/Sign up if you aren't.
- **Live collaborative editing** — last-write-wins broadcast over WebSockets, CodeMirror-based.
- **Presence & remote cursors** — colored avatars and live cursor bookmarks per collaborator.
- **Live syntax linting** — the server runs `compile()` (Python) or `node --check` (JavaScript)
  on every pause in typing and reports syntax errors as red squiggles in the gutter, for everyone in the room.
- **Run code** — a "▶ Run" button executes the current buffer (Python via `python3`, JavaScript via `node`)
  in a subprocess with a 5-second timeout and shows stdout/stderr in a console panel.
  **Security note**: this is a hackathon-grade sandbox (subprocess + timeout only, no
  container isolation). Do not expose `/api/run` on a public multi-tenant deployment
  without adding real sandboxing (e.g. gVisor, firejail, Docker-per-run).
- **Session replay** — every code change is logged with a timestamp; the "⏪ Replay" button
  loads a scrubber so you can watch how the code evolved.
- **Room chat sidebar** — a simple text chat panel per room, backed by the same Socket.IO connection.
- **Voice call** — a peer-to-peer WebRTC mesh (no external TURN/PeerJS service required for a same-network
  demo; uses Google's public STUN server). The Flask/Socket.IO backend only relays SDP offers/answers
  and ICE candidates, it never touches the audio stream itself.

## How it works

- **Auth**: a `users` table stores `username`, `email`, and a Werkzeug password hash.
  `session["user_id"]` marks who's logged in. `@login_required` gates room creation/joining
  routes (both the HTTP `/api/rooms*` endpoints and the `join` Socket.IO event). No email
  verification or password reset flow — add one before using this beyond a hackathon demo.
- **Rooms**: each room has an id (e.g. `a1b2c3d4`) and is stored as a row in Postgres.
- **Sync strategy**: last-write-wins broadcast over WebSockets, as before.
- **Lint**: `POST /api/lint` compiles/checks the submitted code without executing it,
  and returns `{line, message}` pairs consumed by CodeMirror's lint addon.
- **Run**: `POST /api/run` writes the code to a temp file and executes it in a subprocess
  with a hard timeout, returning captured stdout/stderr.
- **Replay**: every `code_change` event also appends a row to `code_snapshots`;
  `GET /api/rooms/<id>/history` returns the full timestamped list for the scrubber UI.
- **Chat**: `chat_message` socket events are persisted to `chat_messages` and broadcast to the room;
  `GET /api/rooms/<id>/chat` loads history on join.
- **Voice call**: `call_join`/`call_signal`/`call_leave` events relay WebRTC signaling
  between peers in the same room (a simple full mesh — fine for small rooms, not
  recommended much past ~4-5 concurrent callers without an SFU).

## Project structure

```
collab-code-editor/
├── app.py                 # Flask app + Socket.IO event handlers
├── models.py               # SQLAlchemy Room model
├── requirements.txt
├── render.yaml              # one-click Render deployment config
├── templates/index.html
└── static/
    ├── js/editor.js         # room join/create, CodeMirror + socket wiring
    └── css/style.css
```

## Run locally

```bash
# 1. clone and enter
git clone <your-repo-url>
cd collab-code-editor

# 2. create a virtualenv
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate

# 3. install deps
pip install -r requirements.txt

# 4. set up Postgres (or use a free one from Render/Neon/Supabase)
createdb collab_editor        # if using local Postgres

# 5. configure env
cp .env.example .env
# edit .env with your DATABASE_URL and a real SECRET_KEY

# 6. run
python app.py
```

Visit `http://localhost:5000`. Open the same URL in a second browser tab
(or share `http://localhost:5000/?room=<roomid>`) to test collaboration.

## Deploy publicly (so you can access it from another PC)

**Easiest path — Render, free tier, ~5 minutes:**

1. Push this folder to a GitHub repo (see below).
2. Go to [render.com](https://render.com) → New → **Blueprint** → connect your repo.
   Render will read `render.yaml` and provision both the web service and a free
   Postgres database automatically.
3. Wait for the build to finish — Render gives you a public URL like
   `https://collab-code-editor.onrender.com`.
4. Open that URL from any PC. Note: Render's free tier spins down after
   inactivity, so the first load after idling can take ~30s to wake up.

**Push to GitHub:**

```bash
cd collab-code-editor
git init
git add .
git commit -m "Initial commit: real-time collaborative code editor"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## Demo script for judges

1. Create a room, share the invite link (top bar → "Copy invite link").
2. Have a judge open it on their laptop/phone.
3. Type simultaneously in both windows — show live sync + colored cursors.
4. Switch the language dropdown to show syntax highlighting swap in real time.
5. Refresh the page to show persistence (code survives via Postgres).

## Known limitations (good to mention proactively)

- Last-write-wins means two people typing in the *exact* same spot at the
  exact same millisecond can clobber each other — a real OT/CRDT (e.g. Yjs)
  would fix this but is out of scope for a hackathon timeframe.
- Presence list is in-memory, so it resets if the server restarts (fine for a demo).

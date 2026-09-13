import os
import re
import uuid
import tempfile
import subprocess
from datetime import datetime
from functools import wraps

from dotenv import load_dotenv
from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from flask_socketio import SocketIO, join_room, leave_room, emit
from werkzeug.security import generate_password_hash, check_password_hash
from models import db, Room, ChatMessage, CodeSnapshot, User

load_dotenv()  # reads .env into os.environ

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get(
    "DATABASE_URL", "postgresql://localhost/collab_editor"
).replace("postgres://", "postgresql://", 1)  # Render gives postgres:// ; SQLAlchemy wants postgresql://
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db.init_app(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# In-memory presence tracking: room_id -> {sid: {"name": str, "color": str}}
room_users = {}

USER_COLORS = ["#e63946", "#457b9d", "#2a9d8f", "#f4a261", "#8338ec", "#ff006e", "#3a86ff"]

RUN_TIMEOUT_SECONDS = 5

# Only run untrusted code in these two ways, both with a hard timeout and no
# network access assumptions beyond what the OS sandbox already restricts.
# NOTE: this is a hackathon-grade sandbox (subprocess + timeout only) — do not
# expose this endpoint on a multi-tenant production deployment without a real
# sandboxing layer (e.g. gVisor, firejail, or a container-per-run).
RUNNERS = {
    "python": ["python3", "-I"],  # -I: isolated mode, ignores PYTHONPATH/user site
    "javascript": ["node"],
}


def get_color(room_id):
    used = len(room_users.get(room_id, {}))
    return USER_COLORS[used % len(USER_COLORS)]


def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return db.session.get(User, user_id)


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "login required"}), 401
            return redirect(url_for("login_page"))
        return view(*args, **kwargs)
    return wrapped


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/me")
def api_me():
    user = current_user()
    return jsonify(user.to_dict() if user else None)


@app.route("/signup", methods=["GET"])
def signup_page():
    return render_template("signup.html")


@app.route("/login", methods=["GET"])
def login_page():
    return render_template("login.html")


@app.route("/api/signup", methods=["POST"])
def api_signup():
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if not username or not email or not password:
        return jsonify({"error": "Username, email, and password are all required."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400
    if User.query.filter((User.username == username) | (User.email == email)).first():
        return jsonify({"error": "That username or email is already taken."}), 409

    user = User(
        username=username,
        email=email,
        password_hash=generate_password_hash(password),
        created_at=datetime.utcnow(),
    )
    db.session.add(user)
    db.session.commit()

    session["user_id"] = user.id
    return jsonify(user.to_dict())


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(force=True)
    identifier = (data.get("username") or data.get("email") or "").strip()
    password = data.get("password") or ""

    user = User.query.filter(
        (User.username == identifier) | (User.email == identifier.lower())
    ).first()
    if not user or not check_password_hash(user.password_hash, password):
        return jsonify({"error": "Incorrect username/email or password."}), 401

    session["user_id"] = user.id
    return jsonify(user.to_dict())


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.pop("user_id", None)
    return jsonify({"ok": True})


@app.route("/api/rooms", methods=["POST"])
@login_required
def create_room():
    """Create a new room and return its id."""
    room_id = uuid.uuid4().hex[:8]
    room = Room(id=room_id, code="", language="python", updated_at=datetime.utcnow())
    db.session.add(room)
    db.session.commit()
    return jsonify({"room_id": room_id})


@app.route("/api/rooms/<room_id>", methods=["GET"])
@login_required
def get_room(room_id):
    room = db.session.get(Room, room_id)
    if not room:
        # auto-create on first visit so shared links "just work"
        room = Room(id=room_id, code="", language="python", updated_at=datetime.utcnow())
        db.session.add(room)
        db.session.commit()
    return jsonify({"room_id": room.id, "code": room.code, "language": room.language})


@app.route("/api/rooms/<room_id>/chat", methods=["GET"])
def get_chat_history(room_id):
    messages = (
        ChatMessage.query.filter_by(room_id=room_id)
        .order_by(ChatMessage.created_at.asc())
        .limit(200)
        .all()
    )
    return jsonify([m.to_dict() for m in messages])


@app.route("/api/rooms/<room_id>/history", methods=["GET"])
def get_code_history(room_id):
    """Returns a timestamped list of code snapshots for the session-replay slider."""
    snapshots = (
        CodeSnapshot.query.filter_by(room_id=room_id)
        .order_by(CodeSnapshot.created_at.asc())
        .all()
    )
    return jsonify([s.to_dict() for s in snapshots])


@app.route("/api/lint", methods=["POST"])
def lint_code():
    """Lightweight syntax check — not a full linter, just catches syntax errors
    so collaborators see a red squiggle instantly instead of a silent typo."""
    data = request.get_json(force=True)
    code = data.get("code", "")
    language = data.get("language", "python")

    if language == "python":
        try:
            compile(code, "<room>", "exec")
            return jsonify({"errors": []})
        except SyntaxError as e:
            return jsonify({
                "errors": [{
                    "line": (e.lineno or 1) - 1,  # CodeMirror lines are 0-indexed
                    "message": e.msg,
                }]
            })
    elif language == "javascript":
        with tempfile.NamedTemporaryFile(suffix=".js", mode="w", delete=False) as f:
            f.write(code)
            path = f.name
        try:
            result = subprocess.run(
                ["node", "--check", path],
                capture_output=True, text=True, timeout=RUN_TIMEOUT_SECONDS,
            )
            if result.returncode == 0:
                return jsonify({"errors": []})
            match = re.search(r":(\d+)", result.stderr)
            line = int(match.group(1)) - 1 if match else 0
            message = result.stderr.strip().splitlines()[-1] if result.stderr else "Syntax error"
            return jsonify({"errors": [{"line": max(line, 0), "message": message}]})
        except subprocess.TimeoutExpired:
            return jsonify({"errors": []})
        finally:
            os.unlink(path)
    else:
        return jsonify({"errors": []})


@app.route("/api/run", methods=["POST"])
def run_code():
    """Executes the room's current code and returns stdout/stderr.
    Hackathon-grade sandbox: subprocess + timeout only. See RUNNERS note above."""
    data = request.get_json(force=True)
    code = data.get("code", "")
    language = data.get("language", "python")

    runner = RUNNERS.get(language)
    if not runner:
        return jsonify({"output": "", "error": f"Running '{language}' isn't supported.", "timed_out": False})

    suffix = ".py" if language == "python" else ".js"
    with tempfile.NamedTemporaryFile(suffix=suffix, mode="w", delete=False) as f:
        f.write(code)
        path = f.name

    try:
        result = subprocess.run(
            runner + [path],
            capture_output=True, text=True, timeout=RUN_TIMEOUT_SECONDS,
        )
        return jsonify({
            "output": result.stdout[-8000:],
            "error": result.stderr[-4000:],
            "timed_out": False,
        })
    except subprocess.TimeoutExpired:
        return jsonify({"output": "", "error": f"Timed out after {RUN_TIMEOUT_SECONDS}s.", "timed_out": True})
    finally:
        os.unlink(path)


# ---------------- Socket.IO events ----------------

@socketio.on("join")
def on_join(data):
    if not session.get("user_id"):
        return  # reject unauthenticated socket joins
    room_id = data["room_id"]
    username = data.get("username", "Anonymous")
    join_room(room_id)

    color = get_color(room_id)
    room_users.setdefault(room_id, {})[request.sid] = {"name": username, "color": color}

    emit("user_joined", {"sid": request.sid, "name": username, "color": color}, room=room_id, include_self=False)
    emit("presence_list", room_users[room_id], room=room_id)
    emit("your_info", {"sid": request.sid, "color": color})


@socketio.on("disconnect")
def on_disconnect():
    for room_id, users in list(room_users.items()):
        if request.sid in users:
            del users[request.sid]
            emit("user_left", {"sid": request.sid}, room=room_id)
            emit("presence_list", users, room=room_id)
            # let peers tear down any active WebRTC connection to this sid
            emit("call_peer_left", {"sid": request.sid}, room=room_id)


@socketio.on("code_change")
def on_code_change(data):
    """Broadcast the change (last-write-wins), persist the room state, and
    append a timestamped snapshot for session replay."""
    room_id = data["room_id"]
    code = data["code"]

    emit("code_update", {"code": code, "sid": request.sid}, room=room_id, include_self=False)

    now = datetime.utcnow()
    room = db.session.get(Room, room_id)
    if room:
        room.code = code
        room.updated_at = now
        db.session.commit()

    db.session.add(CodeSnapshot(room_id=room_id, code=code, created_at=now))
    db.session.commit()


@socketio.on("cursor_move")
def on_cursor_move(data):
    room_id = data["room_id"]
    emit(
        "cursor_update",
        {"sid": request.sid, "position": data["position"]},
        room=room_id,
        include_self=False,
    )


@socketio.on("language_change")
def on_language_change(data):
    room_id = data["room_id"]
    language = data["language"]
    room = db.session.get(Room, room_id)
    if room:
        room.language = language
        db.session.commit()
    emit("language_update", {"language": language}, room=room_id, include_self=False)


@socketio.on("chat_message")
def on_chat_message(data):
    room_id = data["room_id"]
    username = data.get("username", "Anonymous")
    text = (data.get("text") or "").strip()[:2000]
    if not text:
        return
    now = datetime.utcnow()
    msg = ChatMessage(room_id=room_id, username=username, text=text, created_at=now)
    db.session.add(msg)
    db.session.commit()
    emit("chat_message", {"username": username, "text": text, "created_at": now.isoformat()}, room=room_id)


# ---- WebRTC signaling relay for the voice-call feature ----
# The server never touches audio/video itself — it just relays SDP offers/
# answers and ICE candidates between peers in the same room (a simple mesh).

@socketio.on("call_join")
def on_call_join(data):
    room_id = data["room_id"]
    emit("call_peer_joined", {"sid": request.sid}, room=room_id, include_self=False)


@socketio.on("call_leave")
def on_call_leave(data):
    room_id = data["room_id"]
    emit("call_peer_left", {"sid": request.sid}, room=room_id, include_self=False)


@socketio.on("call_signal")
def on_call_signal(data):
    """data: {room_id, target_sid, signal: {type, sdp?/candidate?}}"""
    emit(
        "call_signal",
        {"sender_sid": request.sid, "signal": data["signal"]},
        room=data["target_sid"],
    )


with app.app_context():
    db.create_all()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, debug=True, allow_unsafe_werkzeug=True)

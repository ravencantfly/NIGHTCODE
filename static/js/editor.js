let socket;
let cm;
let roomId;
let username;
let myColor = "#457b9d";
let applyingRemoteChange = false;
let remoteCursorMarks = {};
let lastLiveCode = "";
let inReplayMode = false;

const landing = document.getElementById("landing");
const editorScreen = document.getElementById("editorScreen");

// ================= Room bootstrap =================
// Create/join button wiring now lives in landing.js (the final-card content
// is built dynamically there, depending on whether the visitor is signed
// in). This file exposes enterRoom() globally so landing.js can call it.

window.enterRoom = function enterRoom(id, initialCode, language = "python", enteringUsername = "Anonymous") {
  roomId = id;
  username = enteringUsername;
  lastLiveCode = initialCode;
  landing.classList.add("hidden");
  editorScreen.classList.remove("hidden");
  document.getElementById("roomIdDisplay").textContent = roomId;

  history.replaceState(null, "", `?room=${roomId}`);

  initEditor(initialCode, language);
  initSocket();
  initChat();
  initRun();
  initReplay();
  initCall();

  document.getElementById("logoutBtn").onclick = async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/";
  };
}

// ================= CodeMirror setup =================

function initEditor(initialCode, language) {
  cm = CodeMirror(document.getElementById("editor"), {
    value: initialCode,
    mode: cmModeFor(language),
    theme: "dracula",
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    lineWrapping: true,
    styleActiveLine: { gutter: true },
    gutters: ["CodeMirror-linenumbers", "CodeMirror-lint-markers"],
    lint: {
      getAnnotations: lintGetAnnotations,
      async: true,
      delay: 600,
    },
  });
  document.getElementById("languageSelect").value = language;

  cm.on("change", (instance, changeObj) => {
    if (applyingRemoteChange || inReplayMode) return;
    lastLiveCode = cm.getValue();
    socket.emit("code_change", { room_id: roomId, code: lastLiveCode });
  });

  cm.on("cursorActivity", () => {
    if (inReplayMode) return;
    const pos = cm.getCursor();
    socket.emit("cursor_move", { room_id: roomId, position: pos });
  });

  document.getElementById("languageSelect").onchange = (e) => {
    cm.setOption("mode", cmModeFor(e.target.value));
    socket.emit("language_change", { room_id: roomId, language: e.target.value });
    cm.performLint && cm.performLint();
  };
}

function cmModeFor(language) {
  const map = {
    python: "python",
    javascript: "javascript",
    cpp: "text/x-c++src",
    java: "text/x-java",
    plaintext: "text/plain",
  };
  return map[language] || "python";
}

function currentLanguage() {
  return document.getElementById("languageSelect").value;
}

// ================= Feature: live lint =================

function lintGetAnnotations(text, updateLinting) {
  const language = currentLanguage();
  if (language !== "python" && language !== "javascript") {
    updateLinting([]);
    return;
  }
  fetch("/api/lint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: text, language }),
  })
    .then((res) => res.json())
    .then((data) => {
      const annotations = (data.errors || []).map((err) => ({
        message: err.message,
        severity: "error",
        from: CodeMirror.Pos(err.line, 0),
        to: CodeMirror.Pos(err.line, 100),
      }));
      updateLinting(annotations);
    })
    .catch(() => updateLinting([]));
}

// ================= Socket.IO wiring =================

function initSocket() {
  socket = io();

  socket.on("connect", () => {
    socket.emit("join", { room_id: roomId, username });
  });

  socket.on("your_info", (data) => {
    myColor = data.color;
  });

  socket.on("code_update", (data) => {
    if (inReplayMode) return; // don't let live edits clobber the replay view
    lastLiveCode = data.code;
    applyingRemoteChange = true;
    const cursor = cm.getCursor();
    cm.setValue(data.code);
    cm.setCursor(cursor);
    applyingRemoteChange = false;
  });

  socket.on("language_update", (data) => {
    document.getElementById("languageSelect").value = data.language;
    cm.setOption("mode", cmModeFor(data.language));
  });

  socket.on("presence_list", (users) => renderPresence(users));

  socket.on("user_joined", (data) => flashToast(`${data.name} joined`));

  socket.on("user_left", () => {});

  socket.on("cursor_update", (data) => showRemoteCursor(data.sid, data.position));

  registerChatSocketEvents();
  registerCallSocketEvents();
}

function renderPresence(users) {
  const el = document.getElementById("presenceList");
  el.innerHTML = "";
  Object.values(users).forEach((u) => {
    const badge = document.createElement("span");
    badge.className = "presence-badge";
    badge.style.background = u.color;
    badge.textContent = u.name[0].toUpperCase();
    badge.title = u.name;
    el.appendChild(badge);
  });
}

function flashToast(msg) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

function showRemoteCursor(sid, pos) {
  if (remoteCursorMarks[sid]) remoteCursorMarks[sid].clear();
  const cursorEl = document.createElement("span");
  cursorEl.className = "remote-cursor";
  cursorEl.style.borderLeftColor = myColor;
  remoteCursorMarks[sid] = cm.setBookmark(pos, { widget: cursorEl });
}

document.getElementById("copyLinkBtn").onclick = () => {
  const url = `${window.location.origin}/?room=${roomId}`;
  navigator.clipboard.writeText(url);
  flashToast("Invite link copied!");
};

// ================= Feature: Run code =================

function initRun() {
  const runBtn = document.getElementById("runBtn");
  const panel = document.getElementById("consolePanel");
  const output = document.getElementById("consoleOutput");

  runBtn.onclick = async () => {
    const language = currentLanguage();
    if (language !== "python" && language !== "javascript") {
      flashToast("Running is only supported for Python and JavaScript");
      return;
    }
    panel.classList.remove("hidden");
    output.textContent = "Running...";
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: cm.getValue(), language }),
      });
      const data = await res.json();
      let text = data.output || "";
      if (data.error) text += (text ? "\n" : "") + data.error;
      output.textContent = text || "(no output)";
    } catch (e) {
      output.textContent = "Failed to reach the server.";
    }
  };

  document.getElementById("consoleCloseBtn").onclick = () => panel.classList.add("hidden");
}

// ================= Feature: room chat sidebar =================

function initChat() {
  const sidebar = document.getElementById("chatSidebar");
  document.getElementById("chatToggleBtn").onclick = () => sidebar.classList.toggle("hidden");

  document.getElementById("chatForm").onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById("chatInput");
    const text = input.value.trim();
    if (!text) return;
    socket.emit("chat_message", { room_id: roomId, username, text });
    input.value = "";
  };

  fetch(`/api/rooms/${roomId}/chat`)
    .then((res) => res.json())
    .then((messages) => messages.forEach(renderChatMessage));
}

function registerChatSocketEvents() {
  socket.on("chat_message", (msg) => renderChatMessage(msg));
}

function renderChatMessage(msg) {
  const container = document.getElementById("chatMessages");
  const el = document.createElement("div");
  el.className = "chat-message";
  const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  el.innerHTML = `<span class="chat-username">${escapeHtml(msg.username)}</span> <span class="chat-time">${time}</span><div class="chat-text">${escapeHtml(msg.text)}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ================= Feature: session replay =================

function initReplay() {
  const bar = document.getElementById("replayBar");
  const slider = document.getElementById("replaySlider");
  const timestampEl = document.getElementById("replayTimestamp");
  let history_ = [];

  document.getElementById("replayBtn").onclick = async () => {
    const res = await fetch(`/api/rooms/${roomId}/history`);
    history_ = await res.json();
    if (history_.length === 0) {
      flashToast("No history yet for this room");
      return;
    }
    inReplayMode = true;
    cm.setOption("readOnly", true);
    bar.classList.remove("hidden");
    slider.max = history_.length - 1;
    slider.value = history_.length - 1;
    showSnapshot(history_.length - 1);
  };

  slider.oninput = () => showSnapshot(parseInt(slider.value, 10));

  function showSnapshot(idx) {
    const snap = history_[idx];
    if (!snap) return;
    applyingRemoteChange = true;
    cm.setValue(snap.code);
    applyingRemoteChange = false;
    timestampEl.textContent = snap.created_at ? new Date(snap.created_at).toLocaleTimeString() : "";
  }

  document.getElementById("replayCloseBtn").onclick = () => {
    inReplayMode = false;
    cm.setOption("readOnly", false);
    bar.classList.add("hidden");
    applyingRemoteChange = true;
    cm.setValue(lastLiveCode);
    applyingRemoteChange = false;
  };
}

// ================= Feature: WebRTC voice call =================

let localStream = null;
let peerConnections = {}; // sid -> RTCPeerConnection
let inCall = false;

const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function initCall() {
  document.getElementById("callBtn").onclick = async () => {
    if (inCall) return;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      flashToast("Microphone access denied");
      return;
    }
    inCall = true;
    document.getElementById("callBar").classList.remove("hidden");
    socket.emit("call_join", { room_id: roomId });
  };

  document.getElementById("callLeaveBtn").onclick = () => leaveCall();
}

function leaveCall() {
  if (!inCall) return;
  inCall = false;
  socket.emit("call_leave", { room_id: roomId });
  Object.keys(peerConnections).forEach(closePeerConnection);
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  document.getElementById("callBar").classList.add("hidden");
  document.getElementById("remoteAudios").innerHTML = "";
}

function closePeerConnection(sid) {
  const pc = peerConnections[sid];
  if (pc) pc.close();
  delete peerConnections[sid];
  const audioEl = document.getElementById(`remote-audio-${sid}`);
  if (audioEl) audioEl.remove();
}

function createPeerConnection(sid) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[sid] = pc;

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("call_signal", {
        room_id: roomId,
        target_sid: sid,
        signal: { type: "candidate", candidate: event.candidate },
      });
    }
  };

  pc.ontrack = (event) => {
    let audioEl = document.getElementById(`remote-audio-${sid}`);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = `remote-audio-${sid}`;
      audioEl.autoplay = true;
      document.getElementById("remoteAudios").appendChild(audioEl);
    }
    audioEl.srcObject = event.streams[0];
  };

  return pc;
}

function registerCallSocketEvents() {
  socket.on("call_peer_joined", async (data) => {
    if (!inCall) return;
    const sid = data.sid;
    const pc = createPeerConnection(sid);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("call_signal", {
      room_id: roomId,
      target_sid: sid,
      signal: { type: "offer", sdp: offer.sdp },
    });
  });

  socket.on("call_signal", async (data) => {
    const sid = data.sender_sid;
    const signal = data.signal;
    let pc = peerConnections[sid];

    if (signal.type === "offer") {
      if (!inCall) {
        // A call is happening but we haven't joined — ignore silently.
        return;
      }
      if (!pc) pc = createPeerConnection(sid);
      await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("call_signal", {
        room_id: roomId,
        target_sid: sid,
        signal: { type: "answer", sdp: answer.sdp },
      });
    } else if (signal.type === "answer") {
      if (pc) await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
    } else if (signal.type === "candidate") {
      if (pc) {
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch (e) {
          // ICE candidates can race with connection teardown; safe to ignore.
        }
      }
    }
  });

  socket.on("call_peer_left", (data) => closePeerConnection(data.sid));
}

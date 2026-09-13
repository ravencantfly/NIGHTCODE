// Scroll-driven landing page: brand title glides from centered/huge to a
// small top-right anchor as the user scrolls, three step explainers fade in
// and out along the way, and a final card appears once the user has
// scrolled to the bottom — showing Create/Join if they're signed in, or
// Sign in/Sign up if they aren't.

let currentUser = null;

async function loadCurrentUser() {
  try {
    const res = await fetch("/api/me");
    currentUser = await res.json();
  } catch (e) {
    currentUser = null;
  }
  renderFinalCard();
}

function renderFinalCard() {
  const card = document.getElementById("finalCard");
  if (currentUser) {
    card.innerHTML = `
      <p class="final-card-welcome">Welcome back, ${escapeHtmlLanding(currentUser.username)}</p>
      <button id="createBtn" class="btn-primary">Create a new room</button>
      <div class="divider">or</div>
      <input id="joinRoomId" class="input-field" placeholder="Room code (e.g. a1b2c3d4)">
      <button id="joinBtn" class="btn-primary">Join room</button>
    `;
    document.getElementById("createBtn").onclick = async () => {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (res.status === 401) return (window.location.href = "/login");
      const data = await res.json();
      window.enterRoom(data.room_id, "", "python", currentUser.username);
    };
    document.getElementById("joinBtn").onclick = async () => {
      const id = document.getElementById("joinRoomId").value.trim();
      if (!id) return alert("Enter a room code");
      const res = await fetch(`/api/rooms/${id}`);
      if (res.status === 401) return (window.location.href = "/login");
      const data = await res.json();
      window.enterRoom(data.room_id, data.code || "", data.language || "python", currentUser.username);
    };
  } else {
    const params = new URLSearchParams(window.location.search);
    const nextParam = params.get("room")
      ? `?next=${encodeURIComponent(window.location.href)}`
      : "";
    card.innerHTML = `
      <p class="final-card-welcome">Sign in to create or join a room.</p>
      <a href="/login${nextParam}" class="btn-primary btn-link">Sign in</a>
      <a href="/signup${nextParam}" class="btn-primary btn-link btn-secondary">Sign up</a>
    `;
  }

  renderHeaderAuth();

  // If the URL already has ?room=xxx (an invite link), jump straight in
  // once we know whether the visitor is authenticated.
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get("room");
  if (roomFromUrl && currentUser) {
    fetch(`/api/rooms/${roomFromUrl}`)
      .then((res) => res.json())
      .then((data) => window.enterRoom(data.room_id, data.code || "", data.language || "python", currentUser.username));
  } else if (roomFromUrl && currentUser === null) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.href)}`;
  }
}

// The header's quick-access CTA, opposite the docked title: "Create room"
// once signed in, otherwise a compact "Sign in".
function renderHeaderAuth() {
  const slot = document.getElementById("headerAuthSlot");
  if (!slot) return;

  if (currentUser) {
    slot.innerHTML = `<button id="headerCreateBtn" class="header-auth-btn">Create room</button>`;
    document.getElementById("headerCreateBtn").onclick = async () => {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (res.status === 401) return (window.location.href = "/login");
      const data = await res.json();
      window.enterRoom(data.room_id, "", "python", currentUser.username);
    };
  } else {
    const params = new URLSearchParams(window.location.search);
    const nextParam = params.get("room")
      ? `?next=${encodeURIComponent(window.location.href)}`
      : "";
    slot.innerHTML = `<a href="/login${nextParam}" class="header-auth-btn">Sign in</a>`;
  }
}

function escapeHtmlLanding(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---- Scroll choreography ----

function initScrollChoreography() {
  const title = document.getElementById("brandTitle");
  const header = document.getElementById("landingHeader");
  const headerAuthSlot = document.getElementById("headerAuthSlot");
  const hint = document.getElementById("scrollHint");
  const finalCard = document.getElementById("finalCard");
  const steps = [
    document.getElementById("step0"),
    document.getElementById("step1"),
    document.getElementById("step2"),
    document.getElementById("step3"),
  ];

  function onScroll() {
    const scrollY = window.scrollY;
    const track = document.querySelector(".scroll-track");
    const maxScroll = track.offsetHeight - window.innerHeight;
    const progress = maxScroll > 0 ? Math.min(Math.max(scrollY / maxScroll, 0), 1) : 0;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Title starts perfectly centered, then docks into the header — fast,
    // within roughly one scroll gesture, rather than crawling across the
    // whole page.
    const dockDistance = Math.max(280, vh * 0.32);
    const dockProgress = Math.min(Math.max(scrollY / dockDistance, 0), 1);
    const eased = dockProgress * dockProgress * (3 - 2 * dockProgress); // smoothstep

    const dockedX = 92;   // left-aligned in the header
    const dockedY = 36;   // vertical center of the 72px header
    const dockedScale = 0.32;

    const x = eased * (dockedX - vw * 0.5);
    const y = eased * (dockedY - vh * 0.5);
    const scale = 1 + (dockedScale - 1) * eased;

    // Centered via translate(-50%, -50%) at rest, offset from there as it docks.
    title.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${scale})`;

    header.style.background = `rgba(10, 10, 14, ${0.55 * eased})`;
    header.style.borderBottomColor = `rgba(255, 255, 255, ${0.08 * eased})`;
    header.style.backdropFilter = `blur(${14 * eased}px)`;
    header.style.webkitBackdropFilter = `blur(${14 * eased}px)`;

    const btnReveal = Math.min(Math.max((eased - 0.7) / 0.3, 0), 1);
    headerAuthSlot.style.opacity = btnReveal;
    headerAuthSlot.style.transform = `translateY(${(1 - btnReveal) * -6}px)`;
    headerAuthSlot.style.pointerEvents = btnReveal > 0.5 ? "auto" : "none";

    hint.style.opacity = Math.max(1 - dockProgress * 3, 0);

    // Four stages: step0 (intro) -> step1 -> step2 -> step3, each occupying
    // an equal slice of the scroll range, fading in/out at its edges.
    const stageCount = steps.length;
    const stageProgress = progress * stageCount;
    steps.forEach((el, i) => {
      const local = stageProgress - i; // -1..1 roughly within this step's window
      const visibility = 1 - Math.min(Math.abs(local - 0.5) * 2.4, 1);
      el.style.opacity = Math.max(visibility, 0);
      el.style.pointerEvents = visibility > 0.5 ? "auto" : "none";
    });

    // Final card appears once we're essentially at the bottom.
    if (progress > 0.92) {
      finalCard.classList.remove("hidden");
      finalCard.style.opacity = Math.min((progress - 0.92) / 0.08, 1);
    } else {
      finalCard.style.opacity = 0;
      finalCard.classList.add("hidden");
    }
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  onScroll();
}

window.addEventListener("DOMContentLoaded", () => {
  initScrollChoreography();
  loadCurrentUser();
});

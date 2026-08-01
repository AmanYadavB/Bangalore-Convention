// Shared helpers for all pages.

// ---- Theme ----
function currentTheme() {
  return localStorage.getItem("theme") || "daylight";
}

function applyTheme(name) {
  document.documentElement.setAttribute("data-theme", name);
  localStorage.setItem("theme", name);
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = name === "daylight" ? "\uD83C\uDF19" : "\u2600\uFE0F";
}

function toggleTheme() {
  applyTheme(currentTheme() === "midnight" ? "daylight" : "midnight");
}

// Apply the saved theme as early as possible.
applyTheme(currentTheme());

const money = (n) =>
  "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function toast(message, type = "success") {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.className = "toast " + type;
  el.textContent = message;
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2800);
}

function escapeHtml(str) {
  return String(str || "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c])
  );
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ---- Roles / auth (demo: admin logs in with no credentials) ----
function isAdmin() {
  const r = localStorage.getItem("role");
  return r === "admin" || r === "developer";
}

// Developers are staff who additionally hold the DEV_KEY and can build pages.
function isDeveloper() {
  return localStorage.getItem("role") === "developer" && !!localStorage.getItem("devKey");
}

function getDevKey() {
  return localStorage.getItem("devKey") || "";
}

// Verify a developer key against the server, then unlock developer mode.
async function loginDeveloper(key) {
  const clean = String(key || "").trim();
  if (!clean) return false;
  try {
    const res = await api("/api/dev/verify", {
      method: "POST",
      body: JSON.stringify({ devKey: clean }),
    });
    if (res && res.ok) {
      localStorage.setItem("role", "developer");
      localStorage.setItem("devKey", clean);
      return true;
    }
  } catch (err) {
    console.warn("[dev] verify failed", err);
  }
  return false;
}

function login() {
  localStorage.setItem("role", "admin");
  location.reload();
}

function logout() {
  localStorage.removeItem("role");
  localStorage.removeItem("devKey");
  location.href = "index.html";
}

// Guard an admin-only page: shows a login prompt and returns false for normal users.
function ensureAdmin() {
  if (isAdmin()) return true;
  const c = document.querySelector(".container");
  if (c) {
    c.innerHTML = `
      <div class="card" style="max-width:460px;margin:60px auto;text-align:center">
        <h2 style="margin-top:0">Admin access required</h2>
        <p class="muted">This section is for the organising committee. Log in as admin to continue.</p>
        <button class="btn primary" type="button" onclick="login()">Login as Admin</button>
      </div>`;
  }
  return false;
}

// Render the shared navigation bar.
function renderNav(active) {
  const admin = isAdmin();
  const links = [
    { href: "index.html", label: "Home", key: "home" },
    { href: "register.html", label: "Register", key: "register" },
    { href: "registrations.html", label: "Registrations", key: "registrations", admin: true },
    { href: "dashboard.html", label: "Dashboard", key: "dashboard", admin: true },
    { href: "expenses.html", label: "Expenses", key: "expenses", admin: true },
    { href: "pages.html", label: "Feed AI", key: "pages", dev: true },
  ].filter((l) => (!l.admin || admin) && (!l.dev || isDeveloper()));

  const authBtn = admin
    ? `<button class="btn small auth-btn" id="authBtn" type="button">Logout</button>`
    : `<button class="btn primary small auth-btn" id="authBtn" type="button">Login</button>`;

  return `
  <nav class="nav">
    <a class="brand" href="index.html">
      <span class="logo"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="9.2" stroke="rgba(255,255,255,0.9)" stroke-width="1.5"/><polygon points="12,6 17,15.5 7,15.5" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" fill="none"/></svg></span>
      <span class="brand-name"><b>Bangalore Convention</b>
        <small>Unity · Service · Recovery</small>
      </span>
    </a>
    <button class="theme-toggle" id="themeToggle" type="button" title="Switch theme" aria-label="Switch theme">\u2600\uFE0F</button>
    <button class="nav-toggle" id="navToggle" type="button" title="Menu" aria-label="Menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
    <div class="nav-links" id="navLinks">
      ${links
        .map(
          (l) =>
            `<a class="link ${l.key === active ? "active" : ""}" href="${l.href}">${l.label}</a>`
        )
        .join("")}
      ${authBtn}
    </div>
  </nav>`;
}

function mountNav(active) {
  document.documentElement.setAttribute("data-role", isAdmin() ? "admin" : "user");
  const holder = document.getElementById("nav");
  if (holder) holder.innerHTML = renderNav(active);

  const themeBtn = document.getElementById("themeToggle");
  if (themeBtn) themeBtn.addEventListener("click", toggleTheme);

  const authBtn = document.getElementById("authBtn");
  if (authBtn) authBtn.addEventListener("click", () => (isAdmin() ? logout() : login()));

  const navToggle = document.getElementById("navToggle");
  const navLinks = document.getElementById("navLinks");
  if (navToggle && navLinks) {
    navToggle.addEventListener("click", () => {
      const open = navLinks.classList.toggle("open");
      navToggle.classList.toggle("open", open);
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    navLinks.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        navLinks.classList.remove("open");
        navToggle.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      })
    );
  }

  applyTheme(currentTheme());
  mountChat();
}

// ---- Attention mascot: ONE little robot that lives on the chat button. It
// rests in the corner as the chat bubble, morphs into the robot, waves, rolls,
// jumps, sometimes swells into a huge demon with an evil laugh, then takes off
// (helicopter rotor) and flies a loop around the screen before landing back
// home. Clicking it always opens the assistant. Speech bubbles pop up only now
// and then with short lines. Sound only starts after the first user gesture.
function mountMascot() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    return;

  const isChatOpen = () => document.body.classList.contains("chat-open");

  // ---------------- Funny synth sounds (Web Audio, no files) ----------------
  let actx = null;
  const unlock = () => {
    if (actx) return;
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {}
  };
  ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, unlock, { once: true, passive: true })
  );
  // // Ask for the mic on the first interaction so a clap can flip the theme.
  // ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
  //   window.addEventListener(ev, initClap, { once: true, passive: true })
  // );
  const canPlay = () => actx && actx.state === "running" && !document.hidden;

  function tone(freq, start, dur, type, peak) {
    if (!actx) return;
    const t0 = actx.currentTime + start;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type || "square";
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak || 0.05, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }
  function glide(f1, f2, start, dur, type, peak) {
    if (!actx) return;
    const t0 = actx.currentTime + start;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(f1, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak || 0.05, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }
  const longPueee = () => glide(240, 1350, 0, 1.2, "sawtooth", 0.05); // pueeeeeee up
  const longWoooo = () => glide(1250, 220, 0, 1.3, "sine", 0.055); // wooooooo down
  const boops = () => {
    tone(660, 0, 0.09, "square", 0.05);
    tone(880, 0.11, 0.13, "square", 0.05);
  };

  // Extra sounds for the take-off, landing and growing moments.
  const takeoffSound = () => glide(170, 950, 0, 0.8, "sawtooth", 0.06); // whoooosh up
  const landSound = () => glide(760, 150, 0, 0.5, "sine", 0.05); // settle down
  const growSound = () => glide(300, 620, 0, 1.1, "sine", 0.05); // gentle swell

  // ---------------- ONE mascot, living on the chat button ----------------
  const fab = document.getElementById("chatFab");
  if (!fab || fab.__mascotLive) return;
  fab.__mascotLive = true;
  const bubble = document.getElementById("fabBubble");

  // A stationary, waving chat button that stays in the corner while the mascot
  // is off flying, so you can always tap to open the chat.
  const ghost = document.createElement("button");
  ghost.type = "button";
  ghost.className = "fab-ghost";
  ghost.setAttribute("aria-label", "Open chat");
  ghost.setAttribute("title", "Open chat");
  ghost.innerHTML = '<span class="fg-icon">\uD83D\uDCAC</span><span class="fg-hand">\uD83D\uDC4B</span>';
  (fab.parentElement || document.body).appendChild(ghost);
  ghost.addEventListener("click", () => {
    const panel = document.getElementById("chatPanel");
    if (panel && panel.hidden) fab.click();
  });
  function showGhost(on) {
    ghost.classList.toggle("show", !!on && !isChatOpen());
  }

  const SAYS = [
    "hi there! \uD83D\uDC4B",
    "psst\u2026 need help?",
    "ask me anything!",
    "beep boop \uD83E\uDD16",
    "tap me to chat!",
    "I know the schedule!",
    "wheee!",
    "hello! \uD83D\uDE04",
  ];
  function say(txt, ms) {
    if (!bubble || isChatOpen()) return;
    bubble.textContent = txt || SAYS[Math.floor(Math.random() * SAYS.length)];
    bubble.classList.add("show");
    clearTimeout(bubble.__hideTimer);
    bubble.__hideTimer = setTimeout(() => bubble.classList.remove("show"), ms || 2400);
  }
  // Force any lingering speech bubble away immediately (used right before
  // scenes that shouldn't have a message floating over them).
  function hideBubble() {
    if (!bubble) return;
    clearTimeout(bubble.__hideTimer);
    bubble.classList.remove("show");
  }
  function setForm(form) {
    fab.classList.toggle("as-box", form === "box");
    fab.classList.toggle("as-bot", form === "bot");
  }
  function clearMoves() {
    fab.classList.remove(
      "waving", "rolling", "jumping", "huge", "demonic", "flying",
      "mf-windup", "mf-arrive", "mf-idle-wait", "mf-throw", "mf-victory", "mf-land"
    );
    // // Clear any inline styles set during the minute-flip scene.
    // fab.style.transform = '';
    // fab.style.transition = '';
    // fab.style.removeProperty('--mf-dx');
    // fab.style.removeProperty('--mf-dy');
  }

  // Each "scene" performs an action and returns how long it lasts (ms).
  function toMascot() {
    setForm("bot");
    if (canPlay()) boops();
    if (Math.random() < 0.6) say(null, 1800);
    return 1000;
  }
  function toBox() {
    clearMoves();
    setForm("box");
    return 1000;
  }
  function idleBox() {
    return 4500 + Math.random() * 3000;
  }
  function wave() {
    fab.classList.add("waving");
    if (Math.random() < 0.7) say("hello there! \uD83D\uDC4B", 2200);
    if (canPlay() && Math.random() < 0.5) boops();
    setTimeout(() => fab.classList.remove("waving"), 2600);
    return 2900;
  }
  function roll() {
    hideBubble(); // no floating message while it's rolling
    fab.classList.add("rolling");
    if (canPlay()) longWoooo();
    setTimeout(() => fab.classList.remove("rolling"), 1200);
    return 1500;
  }
  function jump() {
    fab.classList.add("jumping");
    if (canPlay()) longPueee();
    setTimeout(() => fab.classList.remove("jumping"), 700);
    return 950;
  }
  function grow() {
    hideBubble(); // no floating message while it's growing huge
    setForm("bot");
    fab.classList.add("huge"); // slowly swells up in the same friendly colours
    if (canPlay()) growSound();
    setTimeout(() => fab.classList.remove("huge"), 5000);
    return 5600;
  }
  function takeOff() {
    clearMoves();
    setForm("bot");
    showGhost(true); // leave a waving chat button behind so you can still tap
    fab.classList.add("flying");
    if (canPlay()) takeoffSound();
    if (Math.random() < 0.6) say("wheee! \uD83D\uDEF8", 1800);
    setTimeout(() => {
      if (canPlay()) (Math.random() < 0.5 ? longPueee : longWoooo)();
    }, 5200);
    setTimeout(() => {
      fab.classList.remove("flying");
      showGhost(false);
      if (canPlay()) landSound();
      if (Math.random() < 0.6) say("I\u2019m back!", 1600);
    }, 13000);
    return 13700;
  }
  
  function antic() {
    const r = Math.random();
    if (r < 0.4) return wave();
    if (r < 0.7) return jump();
    return roll();
  }

  // Run the scenes one after another, forever. Pause while the chat is open.
  // minuteFlipBusy is set while the minute-flip overlay scene is running so that
  // chain() doesn't stomp over it.
  // let minuteFlipBusy = false;

  function chain(steps, done) {
    let i = 0;
    (function step() {
      if (i >= steps.length) return done();
      if (isChatOpen()) {
        clearMoves();
        setForm("box");
        return setTimeout(step, 900);
      }
      const dur = steps[i++]() || 600;
      setTimeout(step, dur);
    })();
  }
  function cycle() {
    chain(
      [
        toMascot,
        antic,
        antic,
        () => (Math.random() < 0.5 ? grow() : antic()),
        antic,
        toBox,
        idleBox,
        toMascot,
        takeOff,
      ],
      cycle
    );
  }

  // ---- Clap to flip the theme (dark <-> light). Best-effort: uses the mic to
  // hear a sharp clap; if the browser blocks the mic, it simply does nothing.
  // let clapStarted = false;
  // function onClap() {
  //   toggleTheme();
  //   say("wooooh seriously?! \uD83D\uDE32", 2400);
  //   if (canPlay()) boops();
  // }
  // async function initClap() {
  //   if (clapStarted) return;
  //   clapStarted = true;
  //   if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  //   try {
  //     const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  //     const ac = actx || new (window.AudioContext || window.webkitAudioContext)();
  //     actx = ac;
  //     const src = ac.createMediaStreamSource(stream);
  //     const analyser = ac.createAnalyser();
  //     analyser.fftSize = 1024;
  //     analyser.smoothingTimeConstant = 0;
  //     src.connect(analyser);
  //     const time = new Uint8Array(analyser.fftSize);
  //     const freq = new Uint8Array(analyser.frequencyBinCount);
  //     const hzPerBin = ac.sampleRate / 2 / analyser.frequencyBinCount;
  //     let prevPeak = 0;
  //     let lastClap = 0;
  //     // A hand-clap is special: a very short, LOUD spike (fast attack from near
  //     // silence) whose energy is spread BROADBAND and BRIGHT (lots of treble).
  //     // Voices, music and the mascot's own beeps are tonal / low-pitched, so we
  //     // reject anything that isn't both wide-band and bright \u2014 that way ONLY a
  //     // real clap flips the theme, not other sounds.
  //     (function listen() {
  //       analyser.getByteTimeDomainData(time);
  //       analyser.getByteFrequencyData(freq);
  //       let peak = 0;
  //       for (let i = 0; i < time.length; i++) {
  //         const v = Math.abs(time[i] - 128);
  //         if (v > peak) peak = v;
  //       }
  //       let total = 0;
  //       let high = 0;
  //       let loudBins = 0;
  //       for (let i = 0; i < freq.length; i++) {
  //         const v = freq[i];
  //         total += v;
  //         if (i * hzPerBin > 2500) high += v; // treble energy
  //         if (v > 96) loudBins++; // how many bands lit up
  //       }
  //       const highRatio = total > 0 ? high / total : 0; // brightness
  //       const spread = loudBins / freq.length; // broadband-ness
  //       const now = performance.now();
  //       const sharp = peak > 80 && prevPeak < 22; // sudden loud from quiet
  //       const clapLike = spread > 0.28 && highRatio > 0.3;
  //       if (sharp && clapLike && now - lastClap > 1200) {
  //         lastClap = now;
  //         onClap();
  //       }
  //       prevPeak = peak;
  //       requestAnimationFrame(listen);
  //     })();
  //   } catch (e) {
  //     /* mic blocked or unavailable \u2014 clap-to-theme just stays off */
  //   }
  // }

  // ---- Minute-flip scene --------------------------------------------------
  // At second :50 THE ACTUAL mascot (chat-widget wrapper translated via CSS
  // transform) flies to the countdown Mins box.  Sequence:
  //   :50  → wind-up wobble (0.52s)
  //   :50  → pop-up launch phase (0.28s) then arc to counter (1.1s)
  //   :52  → spring-arrival bounce, start gentle hover-bob
  //   :52  → overlay clone of Mins box appears; violent grab-shake
  //   :53  → tear: old number spins 3× into dustbin
  //   :00  → overlay removed, new number slaps in, victory dance
  //   :01  → fly home, minuteFlipBusy = false
  //
  // DOM note: tick() in index.html calls el.innerHTML=… every second, so all
  // .count-box refs go stale.  The overlay absorbs this.  We re-query at :00.
  // -------------------------------------------------------------------------
  // setInterval(() => {
  //   if (isChatOpen() || minuteFlipBusy) return;
  //   if (new Date().getSeconds() !== 50) return;

  //   const countdownEl = document.getElementById("countdown");
  //   if (!countdownEl) return;

  //   const minsBox = Array.from(countdownEl.querySelectorAll(".count-box")).find(
  //     (b) => /min/i.test((b.querySelector(".cap") || {}).textContent || "")
  //   );
  //   if (!minsBox) return;

  //   minuteFlipBusy = true;
  //   clearMoves();       // stop any current fab CSS animation cleanly
  //   setForm("bot");     // show mascot face

  //   const widget = fab.parentElement; // .chat-widget (position:fixed wrapper)
  //   widget.style.transition = "";
  //   widget.style.transform  = "";    // reset any leftover transform

  //   const _t0 = new Date();
  //   const msToFlip = (60 - _t0.getSeconds()) * 1000 - _t0.getMilliseconds();
  //   // Total elapsed by the time the innermost tear callback runs: ~3530ms
  //   const ELAPSED_AT_TEAR = 500 + 280 + 1100 + 620 + 1030;

  //   // ── Stage 1: Wind-up wobble (0 → 520ms) ───────────────────────────────
  //   fab.classList.add("mf-windup");
  //   setTimeout(() => fab.classList.remove("mf-windup"), 520);

  //   // ── Stage 2: Launch (at 500ms) ─────────────────────────────────────────
  //   setTimeout(() => {
  //     if (canPlay()) takeoffSound();

  //     const wR = widget.getBoundingClientRect();
  //     const mR = minsBox.getBoundingClientRect();
  //     const dx = (mR.left + mR.width  / 2) - (wR.left + wR.width  / 2);
  //     const dy = (mR.top  - 40) - wR.top;

  //     // Phase A: pop upward first (like a rocket ignition)
  //     widget.style.transition = "transform 0.28s cubic-bezier(0.4,0,1,1)";
  //     widget.style.transform  = "translate(0,-32px) scale(1.24) rotate(-8deg)";

  //     // Phase B: arc across to the counter
  //     setTimeout(() => {
  //       widget.style.transition = "transform 1.1s cubic-bezier(0.4,0,0.2,1)";
  //       widget.style.transform  = `translate(${dx}px,${dy}px) scale(1) rotate(0deg)`;
  //     }, 280);
  //   }, 500);

  //   // ── Stage 3: Arrive at counter (500+280+1100 = 1880ms) ─────────────────
  //   setTimeout(() => {
  //     if (canPlay()) landSound();
  //     fab.classList.add("mf-arrive");
  //     setTimeout(() => fab.classList.remove("mf-arrive"), 680);

  //     // ── Stage 4: Idle hover + create overlay + grab (at arrive+620ms) ───
  //     setTimeout(() => {
  //       if (canPlay()) boops();
  //       fab.classList.add("mf-idle-wait");

  //       // Clone Mins box into fixed overlay so tick() DOM rebuilds don't hurt.
  //       const mR = minsBox.getBoundingClientRect();
  //       const overlay = document.createElement("div");
  //       overlay.className = "min-flip-overlay";
  //       overlay.style.left   = mR.left   + "px";
  //       overlay.style.top    = mR.top    + "px";
  //       overlay.style.width  = mR.width  + "px";
  //       overlay.style.height = mR.height + "px";
  //       overlay.innerHTML    = minsBox.innerHTML;
  //       document.body.appendChild(overlay);

  //       const oNum = overlay.querySelector(".num");
  //       if (oNum) oNum.classList.add("mf-grab");

  //       // ── Stage 5: Tear it off (at +1030ms) ───────────────────────────────
  //       setTimeout(() => {
  //         // Switch overlay .num from grab to tear (3 full spins into bin)
  //         if (oNum) {
  //           oNum.classList.remove("mf-grab");
  //           oNum.classList.add("mf-tear");
  //         }

  //         // Fab stops hovering, does a dramatic throw twitch
  //         fab.classList.remove("mf-idle-wait");
  //         fab.classList.add("mf-throw");
  //         setTimeout(() => {
  //           fab.classList.remove("mf-throw");
  //           fab.classList.add("mf-idle-wait"); // hover again while waiting
  //         }, 400);

  //         // Dustbin pops below the Mins box
  //         const bin = document.createElement("div");
  //         bin.className = "min-dustbin-el";
  //         bin.textContent = "🗑️";
  //         bin.style.left = mR.left + mR.width  / 2 - 18 + "px";
  //         bin.style.top  = mR.bottom + 12 + "px";
  //         document.body.appendChild(bin);
  //         setTimeout(() => bin.remove(), 2000);

  //         // ── Stage 6: New number slaps in at :00 + 80ms grace ────────────
  //         const msUntilSlap = msToFlip - ELAPSED_AT_TEAR + 80;

  //         setTimeout(() => {
  //           fab.classList.remove("mf-idle-wait");
  //           overlay.remove(); // reveal freshly-updated live counter

  //           // Triumphant 4-note arpeggio
  //           if (canPlay()) {
  //             tone(440, 0,    0.07, "square", 0.055);
  //             tone(554, 0.07, 0.07, "square", 0.055);
  //             tone(659, 0.14, 0.07, "square", 0.055);
  //             tone(880, 0.21, 0.2,  "square", 0.07);
  //           }

  //           // Re-query — tick() has rebuilt all .count-box elements.
  //           const newMinsBox = Array.from(
  //             countdownEl.querySelectorAll(".count-box")
  //           ).find(
  //             (b) => /min/i.test((b.querySelector(".cap") || {}).textContent || "")
  //           );
  //           if (newMinsBox) {
  //             newMinsBox.classList.add("min-num-slapin");
  //             setTimeout(() => newMinsBox.classList.remove("min-num-slapin"), 800);
  //           }

  //           // Victory dance on the fab
  //           fab.classList.add("mf-victory");
  //           setTimeout(() => fab.classList.remove("mf-victory"), 730);

  //           // ── Stage 7: Fly home after victory (at +730ms) ─────────────────
  //           setTimeout(() => {
  //             if (canPlay()) takeoffSound();
  //             widget.style.transition =
  //               "transform 0.92s cubic-bezier(0.34,1.56,0.64,1)";
  //             widget.style.transform = "";

  //             setTimeout(() => {
  //               widget.style.transition = "";
  //               if (canPlay()) landSound();
  //               // Brief landing bounce reusing mf-arrive
  //               fab.classList.add("mf-arrive");
  //               setTimeout(() => fab.classList.remove("mf-arrive"), 680);
  //               clearMoves();
  //               setForm("box");
  //               minuteFlipBusy = false;
  //             }, 960);
  //           }, 730);
  //         }, Math.max(msUntilSlap, 600));
  //       }, 1030);
  //     }, 620);
  //   }, 1880);
  // }, 500);

  // Start life as the chat bubble in the corner, then begin the loop.
  setForm("box");
  setTimeout(cycle, 1000);

  // When the chat opens, calm down and stay a plain chat button.
  const obs = new MutationObserver(() => {
    if (isChatOpen()) {
      clearMoves();
      showGhost(false);
      setForm("box");
    }
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
}

// ---- Razorpay payment helper (used by register.html form AND in-chat booking) ----
//
// record  – the registration object returned by POST /api/registrations
//           (must have: id, amount, name, email, phone, categoryName)
// onSuccess(record) – called after payment succeeds OR if payment is skipped/dismissed
//
async function openRazorpay(record, onSuccess) {
  // Lazily load the Razorpay checkout SDK.
  if (!window.Razorpay) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load Razorpay SDK"));
      document.head.appendChild(s);
    }).catch(() => null);
  }

  // Ask the backend to create a Razorpay order.
  let orderData;
  try {
    orderData = await api("/api/payment/create-order", {
      method: "POST",
      body: JSON.stringify({ registrationId: record.id, amount: record.amount }),
    });
  } catch (_) {
    // Network error or backend unavailable — fall through without payment.
    onSuccess(record);
    return;
  }

  // If keys are not configured yet, show a clear warning instead of silently skipping.
  if (orderData.skipped || !window.Razorpay) {
    console.warn("[payment] Razorpay not configured — add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to your Cloudflare Worker env vars.");
    toast("⚠️ Payment gateway not configured yet — registration saved, payment pending.", "info");
    onSuccess(record);
    return;
  }

  const options = {
    key: orderData.keyId,
    amount: orderData.amount,           // in paise, as returned by Razorpay
    currency: orderData.currency || "INR",
    name: "Bangalore Convention 2027",
    description: record.categoryName || "Convention Registration",
    order_id: orderData.orderId,
    prefill: {
      name: record.name || "",
      email: record.email || "",
      contact: record.phone || "",
    },
    theme: { color: "#5b6cf8" },

    // Called by Razorpay on successful payment (before the modal closes).
    handler: async function (response) {
      let verified = false;
      try {
        await api("/api/payment/verify", {
          method: "POST",
          body: JSON.stringify({
            registrationId: record.id,
            razorpayOrderId: response.razorpay_order_id,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpaySignature: response.razorpay_signature,
          }),
        });
        verified = true;
      } catch (_) { /* verification error — still show confirmation */ }
      onSuccess({ ...record, paid: verified, paymentId: response.razorpay_payment_id });
    },

    modal: {
      // User closed the checkout without paying — show registration with pending status.
      ondismiss: function () { onSuccess(record); },
    },
  };

  try {
    const rzp = new window.Razorpay(options);
    rzp.open();
  } catch (_) {
    onSuccess(record);
  }
}

// ---- AI chat assistant (Cloudflare Workers AI on the live site) ----
function mountChat() {
  if (document.getElementById("chatWidget")) return;

  const wrap = document.createElement("div");
  wrap.id = "chatWidget";
  wrap.className = "chat-widget";
  wrap.innerHTML = `
    <button class="chat-fab as-box" id="chatFab" type="button" aria-label="Open chat" title="Ask a question">
      <span class="fab-bubble" id="fabBubble" aria-hidden="true"></span>
      <span class="fab-box">\uD83D\uDCAC</span>
      <span class="fab-mascot" aria-hidden="true">
        <span class="fm-rotor"></span>
        <span class="fm-antenna"></span>
        <span class="fm-head"><i class="fm-eye"></i><i class="fm-eye"></i></span>
        <span class="fm-body"></span>
        <span class="fm-arm"></span>
        <span class="fm-legs"><i></i><i></i></span>
      </span>
    </button>
    <section class="chat-panel" id="chatPanel" aria-live="polite" hidden>
      <header class="chat-head">
        <div class="chat-head-main">
          <span class="chat-avatar mini-bot" id="chatAvatar" aria-hidden="true">
            <i class="mb-eye"></i><i class="mb-eye"></i><span class="mb-mouth"></span>
          </span>
          <div>
            <strong>Convention Helper</strong>
            <small>Ask about registration &amp; pricing</small>
          </div>
        </div>
        <button class="chat-close" id="chatClose" type="button" aria-label="Close chat">\u00d7</button>
      </header>
      <div class="chat-log" id="chatLog"></div>
      <div class="chat-voice" id="chatVoice" hidden>
        <span class="voice-orb" aria-hidden="true"></span>
        <span class="voice-viz" id="voiceViz" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <span id="chatVoiceLabel">Talk mode on</span>
        <button type="button" id="chatVoiceStop" class="chat-voice-stop">Stop</button>
      </div>
      <form class="chat-input" id="chatForm">
        <button class="chat-mic" id="chatMic" type="button" aria-label="Talk mode" title="Talk mode (voice)">\uD83C\uDFA4</button>
        <input id="chatText" type="text" autocomplete="off" placeholder="Type your question\u2026" />
        <button class="btn primary small" type="submit" id="chatSend">Send</button>
      </form>
    </section>`;
  document.body.appendChild(wrap);
  mountMascot();

  const history = [];
  const panel = document.getElementById("chatPanel");
  const fab = document.getElementById("chatFab");
  const log = document.getElementById("chatLog");
  const form = document.getElementById("chatForm");
  const text = document.getElementById("chatText");
  const sendBtn = document.getElementById("chatSend");
  const micBtn = document.getElementById("chatMic");
  const voiceBar = document.getElementById("chatVoice");
  const voiceLabel = document.getElementById("chatVoiceLabel");
  let greeted = false;
  let lastUserText = "";

  // Pre-warm: pick a greeting and start fetching its TTS audio immediately so
  // the very first chat open plays instantly with no perceptible delay.
  const VISITOR_GREETINGS = [
    "Welcome Bro! THE Convention is happening July 9th to 11th. Three inspiring days filled with sessions, community, great food, and unforgettable experiences. What would you like to know?",
    "Hey! Glad you're here! Join us from July 9th to 11th for an amazing convention experience. Whether it's your first time or you're returning, I'd be happy to help. What's on your mind?",
    "Yo! Excited to see your interest in the Convention! this is going to be packed with meaningful connections, engaging activities, and memorable moments. How can I help today?",
    "Bro! The Convention is just around the corner! From July 9th to 11th, Bangalore will host three incredible days of learning, fellowship, and fun. What information are you looking for?"
  ];
  const prewarmGreetingText = VISITOR_GREETINGS[Math.floor(Math.random() * VISITOR_GREETINGS.length)];
  let prewarmAudioP = null; // Promise<base64|null>, resolved once TTS is ready

  // Pricing/categories, loaded once so the bot can book on the user's behalf.
  let PRICING = [];
  api("/api/pricing")
    .then((list) => {
      if (Array.isArray(list)) PRICING = list;
    })
    .catch((err) => console.warn("[chat] could not load pricing", err));

  function addMsg(kind, content) {
    const el = document.createElement("div");
    el.className = "chat-msg " + kind;
    if (kind.indexOf("typing") !== -1 && content === "\u2026") {
      // Make the loading indicator look like the mascot is typing.
      el.innerHTML =
        '<span class="mini-bot thinking" aria-hidden="true"><i class="mb-eye"></i><i class="mb-eye"></i><span class="mb-mouth"></span></span>' +
        '<span class="typing-dots"><i></i><i></i><i></i></span>';
    } else {
      el.innerHTML = escapeHtml(content).replace(/\n/g, "<br>");
    }
    log.appendChild(el);
    scrollToMsg(el, kind);
    return el;
  }

  // Scroll only the chat log (never the whole page). For a finished assistant
  // reply, bring the START of the new message into view so long answers are
  // read from the top instead of jumping to the bottom. For the user's own
  // messages and the typing indicator, snap to the bottom.
  function scrollToMsg(el, kind) {
    const k = String(kind || "");
    const isAssistantReply = k.indexOf("assistant") === 0 && k.indexOf("typing") === -1;
    if (isAssistantReply) {
      const delta = el.getBoundingClientRect().top - log.getBoundingClientRect().top;
      const maxTop = log.scrollHeight - log.clientHeight;
      log.scrollTop = Math.min(maxTop, log.scrollTop + delta - 10);
    } else {
      log.scrollTop = log.scrollHeight;
    }
  }

  // Reveal an assistant reply one character at a time, like the mascot is
  // writing it out on a board. Calls done() when the whole line is written.
  function typeOut(el, txt, msPerChar, done) {
    let i = 0;
    const paint = (withCaret) => {
      const part = escapeHtml(txt.slice(0, i)).replace(/\n/g, "<br>");
      el.innerHTML = withCaret ? part + '<span class="type-caret"></span>' : part;
      scrollToMsg(el, "assistant");
    };
    paint(true);
    const timer = setInterval(() => {
      i++;
      paint(i < txt.length);
      if (i >= txt.length) {
        clearInterval(timer);
        paint(false);
        if (done) done();
      }
    }, msPerChar);
    return timer;
  }

  // Snappy when typing text; a little slower in voice mode so the words appear
  // roughly in step with the spoken audio.
  function writeSpeed(txt, voice) {
    const len = Math.max(1, txt.length);
    return voice
      ? Math.min(60, Math.max(24, Math.round(6500 / len)))
      : Math.min(38, Math.max(9, Math.round(2200 / len)));
  }

  // Build an assistant reply that has the mascot standing right next to it, so
  // it feels like the mascot himself is there producing the words.
  function addAssistantBubble() {
    const row = document.createElement("div");
    row.className = "chat-msg assistant bot-row";
    const bot = document.createElement("span");
    bot.className = "msg-bot mini-bot";
    bot.setAttribute("aria-hidden", "true");
    bot.innerHTML =
      '<i class="mb-eye"></i><i class="mb-eye"></i><span class="mb-mouth"></span>' +
      '<span class="mb-pen">\u270F\uFE0F</span>' +
      '<span class="mb-waves"><i></i><i></i><i></i></span>';
    const txt = document.createElement("span");
    txt.className = "msg-text";
    row.appendChild(bot);
    row.appendChild(txt);
    log.appendChild(row);
    scrollToMsg(row, "assistant");
    return { row, bot, txt };
  }

  // Reveal a reply as if the mascot is scribbling it on screen (text) or saying
  // it out loud (voice) \u2014 the little mascot animates the whole time.
  function typeReply(shown, voice, done) {
    const { bot, txt } = addAssistantBubble();
    // Voice mode: the visualizer bars carry the speaking animation, so the
    // mascot stays still; typed mode keeps its little "writing" scribble.
    if (!voice) bot.classList.add("writing");
    typeOut(txt, shown, writeSpeed(shown, voice), () => {
      bot.classList.remove("writing");
      if (done) done();
    });
  }

  const isMobile = () => window.innerWidth <= 720;

  // Keep the chat panel fitted inside the *visible* viewport. When the mobile
  // keyboard opens, window.visualViewport shrinks; we anchor the panel to that
  // visible area so the header stays on screen and the input sits just above
  // the keyboard instead of the whole page scrolling up.
  function fitPanel() {
    const vv = window.visualViewport;
    if (!isMobile() || !vv) {
      panel.style.position = "";
      panel.style.top = "";
      panel.style.left = "";
      panel.style.right = "";
      panel.style.bottom = "";
      panel.style.width = "";
      panel.style.height = "";
      return;
    }
    const topGap = 12;
    const bottomGap = 12;
    panel.style.position = "fixed";
    panel.style.left = "12px";
    panel.style.right = "12px";
    panel.style.width = "auto";
    panel.style.bottom = "auto";
    panel.style.top = vv.offsetTop + topGap + "px";
    panel.style.height = vv.height - topGap - bottomGap + "px";
  }

  function openChat() {
    startPrewarm(); // no-op if the hover listener already kicked it off
    panel.hidden = false;
    fab.classList.add("open");
    document.body.classList.add("chat-open");
    if (!greeted) {
      greeted = true;
      let greeting;
      if (isDeveloper()) {
        greeting = "dev mode activated! ask me anything — registrations, money, expenses. feed me more knowledge on the Feed AI page and I'll use it instantly.";
      } else if (isAdmin()) {
        greeting = "hey! got live numbers ready — registrations, payments, pending, expenses. what do you need?";
      } else {
        greeting = prewarmGreetingText; // use the pre-warmed text
      }
      // Speak the greeting and show it as text. Mic stays off — user taps it to start.
      if (!isDeveloper() && !isAdmin() && canListen && canSpeak) {
        if (!recognition) initRecognition();
        processing = false;
        speaking = true; // block mic until greeting finishes
        finalBuffer = "";
        lastInterim = "";
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        setVoiceStatus("speaking");
        const myGreetId = ++speakId;
        typeReply(greeting, true);
        // Play the pre-warmed Deepgram audio if ready; fall back to browser TTS.
        (prewarmAudioP || Promise.resolve(null)).then((audio64) => {
          if (audio64 && myGreetId === speakId) {
            playClip(audio64, null, myGreetId).then(() => { if (myGreetId === speakId) afterSpeak(); });
          } else {
            speaking = false;
            browserSpeak(greeting, null);
          }
        });
      } else {
        typeReply(greeting, false);
      }
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", fitPanel);
      window.visualViewport.addEventListener("scroll", fitPanel);
    }
    fitPanel();
  }

  function closeChat() {
    stopVoiceMode();
    panel.hidden = true;
    fab.classList.remove("open");
    document.body.classList.remove("chat-open");
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", fitPanel);
      window.visualViewport.removeEventListener("scroll", fitPanel);
    }
    // Reset any inline sizing so desktop/CSS rules take over again.
    panel.style.position = "";
    panel.style.top = "";
    panel.style.left = "";
    panel.style.right = "";
    panel.style.bottom = "";
    panel.style.width = "";
    panel.style.height = "";
  }

  // ---- Agentic actions ------------------------------------------------------
  // Where the bot can navigate: keyword -> page file.
  const PAGES = {
    home: "index.html",
    index: "index.html",
    register: "register.html",
    registration: "register.html",
    pricing: "index.html#pricing",
    dashboard: "dashboard.html",
    registrations: "registrations.html",
    expenses: "expenses.html",
  };

  const NAV_LABELS = {
    home: "Home",
    index: "Home",
    register: "Register",
    registration: "Register",
    pricing: "Pricing",
    dashboard: "Dashboard",
    registrations: "Registrations",
    expenses: "Expenses",
  };

  // Did the user's last message actually ask to move to a page? Guards against
  // the model deciding to navigate on its own (a common hallucination).
  function userAskedToNavigate(msg) {
    return /\b(go to|goto|take me|bring me|open|show me|navigate|visit|head to|jump to|move to|switch to|send me)\b/i.test(
      msg || ""
    );
  }

  // Are we already viewing this target page?
  function isCurrentPage(target) {
    const file = String(target).split("#")[0].toLowerCase();
    let cur = (location.pathname.split("/").pop() || "").toLowerCase();
    if (!cur) cur = "index.html";
    return cur === file;
  }

  // A tap-to-open suggestion, used instead of an automatic redirect when the
  // navigation wasn't clearly requested.
  function showNavChip(label, target) {
    const card = document.createElement("div");
    card.className = "chat-msg assistant chat-confirm";
    card.innerHTML =
      "<strong>Open the " +
      escapeHtml(label) +
      " page?</strong>" +
      '<div class="chat-confirm-actions">' +
      '<button type="button" class="btn ghost small" data-act="no">No thanks</button>' +
      '<button type="button" class="btn primary small" data-act="go">Open ' +
      escapeHtml(label) +
      "</button>" +
      "</div>";
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    card.querySelector('[data-act="no"]').addEventListener("click", () => card.remove());
    card
      .querySelector('[data-act="go"]')
      .addEventListener("click", () => (window.location.href = target));
  }

  // --- Contact-organiser card ---------------------------------------------------
  // Shown when the bot genuinely can't answer; fires an email to the team.
  function showContactCard(prefillSubject) {
    const CATEGORIES = ["Registration", "Payment", "Schedule", "Accommodation", "Travel", "General"];
    const catOpts = CATEGORIES.map(
      (c) => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + "</option>"
    ).join("");

    const card = document.createElement("div");
    card.className = "chat-msg assistant chat-contact";
    card.innerHTML =
      '<div class="cc-head">\uD83D\uDCE7 Drop the team a message</div>' +
      '<div class="cc-fields">' +
        '<input class="cc-input" id="ccName"  type="text"  placeholder="Your name"  autocomplete="name" />' +
        '<input class="cc-input" id="ccEmail" type="email" placeholder="Your email" autocomplete="email" />' +
        '<select class="cc-input" id="ccCat"><option value="" disabled selected>Category&hellip;</option>' + catOpts + '</select>' +
        '<input class="cc-input" id="ccSubj" type="text" placeholder="Subject" value="' + escapeHtml(prefillSubject) + '" />' +
        '<textarea class="cc-input cc-desc" id="ccDesc" rows="3" placeholder="Describe your question or issue\u2026"></textarea>' +
      '</div>' +
      '<div class="cc-actions">' +
        '<button type="button" class="btn ghost small cc-cancel">Cancel</button>' +
        '<button type="button" class="btn primary small cc-send">Send \uD83D\uDE80</button>' +
      '</div>' +
      '<div class="cc-status" hidden></div>';

    log.appendChild(card);
    log.scrollTop = log.scrollHeight;

    card.querySelector(".cc-cancel").addEventListener("click", () => card.remove());

    card.querySelector(".cc-send").addEventListener("click", async () => {
      const nameVal  = card.querySelector("#ccName").value.trim();
      const emailVal = card.querySelector("#ccEmail").value.trim();
      const catVal   = card.querySelector("#ccCat").value;
      const subjVal  = card.querySelector("#ccSubj").value.trim();
      const descVal  = card.querySelector("#ccDesc").value.trim();
      const status   = card.querySelector(".cc-status");

      if (!nameVal || !emailVal || !catVal || !subjVal || !descVal) {
        status.hidden = false;
        status.className = "cc-status cc-err";
        status.textContent = "Please fill in all fields.";
        return;
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailVal)) {
        status.hidden = false;
        status.className = "cc-status cc-err";
        status.textContent = "Please enter a valid email address.";
        return;
      }

      const sendBtn = card.querySelector(".cc-send");
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending\u2026";
      status.hidden = true;

      try {
        const res = await fetch("/api/contact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: nameVal, email: emailVal,
            category: catVal, subject: subjVal, description: descVal,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          card.querySelector(".cc-fields").remove();
          card.querySelector(".cc-actions").remove();
          status.hidden = false;
          status.className = "cc-status cc-ok";
          status.textContent = "\u2705 Sent! The team will reply to " + emailVal + " soon.";
        } else {
          sendBtn.disabled = false;
          sendBtn.textContent = "Send \uD83D\uDE80";
          status.hidden = false;
          status.className = "cc-status cc-err";
          status.textContent = "Couldn\u2019t send \u2014 please try again. "+ (data.error || "");
        }
      } catch (e) {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send \uD83D\uDE80";
        status.hidden = false;
        status.className = "cc-status cc-err";
        status.textContent = "Network error \u2014 please check your connection.";
      }
    });
  }
  // ---------------------------------------------------------------------------

  // Render an embedded Google Maps route card (no API key needed) for travel to
  // the convention. Only ever called for convention-related travel.
  function showMapCard(from, to) {
    const dest = String(to || "Bangalore, India").trim() || "Bangalore, India";
    const origin = String(from || "").trim();
    const card = document.createElement("div");
    card.className = "chat-msg assistant chat-map";
    const q = origin
      ? "saddr=" + encodeURIComponent(origin) + "&daddr=" + encodeURIComponent(dest)
      : "q=" + encodeURIComponent(dest);
    const embed = "https://maps.google.com/maps?" + q + "&output=embed";
    const link =
      "https://www.google.com/maps/dir/?api=1" +
      (origin ? "&origin=" + encodeURIComponent(origin) : "") +
      "&destination=" +
      encodeURIComponent(dest);
    card.innerHTML =
      "<strong>" +
      (origin ? escapeHtml(origin) + " \u2192 " + escapeHtml(dest) : escapeHtml(dest)) +
      "</strong>" +
      '<div class="chat-map-frame"><iframe title="Route map" loading="lazy" ' +
      'referrerpolicy="no-referrer-when-downgrade" src="' +
      escapeHtml(embed) +
      '"></iframe></div>' +
      '<a class="chat-map-open" target="_blank" rel="noopener" href="' +
      escapeHtml(link) +
      '">Open in Google Maps \u2197</a>';
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
  }

  function normalizeCategory(cat) {
    if (!cat) return null;
    const key = String(cat).trim().toLowerCase();
    const match = PRICING.find(
      (c) =>
        c.id.toLowerCase() === key ||
        c.name.toLowerCase() === key ||
        c.name.toLowerCase().includes(key)
    );
    return match ? match.id : null;
  }

  // Split the model reply into the visible message, an optional action, and an
  // optional full-HTML payload (used by the developer page-building actions).
  function parseReply(raw) {
    const marker = raw.indexOf("[[ACTION]]");
    if (marker === -1) return { message: raw.trim(), action: null, html: null };
    const message = raw.slice(0, marker).trim();
    const rest = raw.slice(marker + "[[ACTION]]".length);
    const htmlIdx = rest.indexOf("[[HTML]]");
    const jsonPart = (htmlIdx === -1 ? rest : rest.slice(0, htmlIdx)).trim();
    let html = null;
    if (htmlIdx !== -1) {
      html = rest.slice(htmlIdx + "[[HTML]]".length);
      // Strip a leading newline and any accidental markdown code fences.
      html = html
        .replace(/^\s*\n/, "")
        .replace(/^```[a-z]*\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();
    }
    let action = null;
    try {
      action = JSON.parse(jsonPart);
    } catch (err) {
      console.warn("[chat] could not parse action JSON", err, jsonPart);
    }
    return { message, action, html };
  }

  function handleAssistantReply(raw, voice) {
    const { message, action, html } = parseReply(raw);
    const shown = message || "Okay.";
    history.push({ role: "assistant", content: shown });
    if (voice) {
      // Defer text + action until the moment audio actually starts playing.
      speak(shown, () => {
        typeReply(shown, true);
        if (action) executeAction(action, html);
      });
    } else {
      typeReply(shown, false);
      if (action) executeAction(action, html);
    }
  }

  function executeAction(action, html) {
    if (!action || !action.action) return;
    if (action.action === "navigate") {
      const key = String(action.to || "").toLowerCase();
      const target = PAGES[key];
      if (!target) return;
      const label = NAV_LABELS[key] || key;
      if (isCurrentPage(target)) {
        addMsg("assistant", "You're already on the " + label + " page.");
        return;
      }
      if (userAskedToNavigate(lastUserText)) {
        // Clear request -> take them, but leave a moment to read the reply.
        addMsg("assistant typing", "Opening the " + label + " page\u2026");
        setTimeout(() => {
          window.location.href = target;
        }, 1200);
      } else {
        // Not a clear navigation ask -> don't redirect on our own; offer a
        // button the user can tap if they actually want to go.
        showNavChip(label, target);
      }
    } else if (action.action === "review_booking") {
      showBookingConfirm(action);
    } else if (action.action === "create_page" || action.action === "update_page") {
      showPageConfirm(action, html);
    } else if (action.action === "delete_page") {
      showPageDelete(action);
    } else if (action.action === "show_map") {
      showMapCard(action.from, action.to);
    } else if (action.action === "contact_organiser") {
      showContactCard(action.subject || "");
    }
  }

  // Developer: review & publish an AI-generated page (stored in D1).
  function showPageConfirm(a, html) {
    if (!isDeveloper()) {
      addMsg(
        "assistant",
        "\u26a0\ufe0f Building pages needs developer access \u2014 unlock it on the Pages screen first."
      );
      return;
    }
    if (!html || !html.trim()) {
      addMsg("assistant", "I couldn't produce the page HTML \u2014 please ask me again.");
      return;
    }
    const slug = String(a.slug || "").trim();
    const title = String(a.title || slug).trim();
    const verb = a.action === "update_page" ? "Update" : "Publish";
    const card = document.createElement("div");
    card.className = "chat-msg assistant chat-confirm";
    card.innerHTML =
      "<strong>" +
      escapeHtml(verb) +
      " page</strong>" +
      '<div class="chat-confirm-row"><span>Title</span><b>' +
      escapeHtml(title) +
      "</b></div>" +
      '<div class="chat-confirm-row"><span>URL</span><b>/p/' +
      escapeHtml(slug) +
      "</b></div>" +
      '<div class="chat-confirm-actions">' +
      '<button type="button" class="btn ghost small" data-act="preview">Preview</button>' +
      '<button type="button" class="btn ghost small" data-act="cancel">Cancel</button>' +
      '<button type="button" class="btn primary small" data-act="ok">' +
      escapeHtml(verb) +
      "</button>" +
      "</div>";
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;

    card.querySelector('[data-act="preview"]').addEventListener("click", () => {
      const blob = new Blob([html], { type: "text/html" });
      window.open(URL.createObjectURL(blob), "_blank");
    });
    card.querySelector('[data-act="cancel"]').addEventListener("click", () => {
      card.remove();
      addMsg("assistant", "Okay, I won't publish it \u2014 tell me what to change.");
    });
    card.querySelector('[data-act="ok"]').addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = "Publishing\u2026";
      try {
        const res = await api("/api/pages", {
          method: "POST",
          body: JSON.stringify({ slug, title, html, devKey: getDevKey() }),
        });
        const url = res.url || "/p/" + slug;
        card.querySelector(".chat-confirm-actions").remove();
        addMsg("assistant", "\u2705 Published! Opening " + url + " now.");
        setTimeout(() => window.open(url, "_blank"), 500);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = verb;
        addMsg("assistant", "\u26a0\ufe0f Couldn't publish: " + (err && err.message ? err.message : err));
      }
    });
  }

  // Developer: confirm deletion of a page.
  function showPageDelete(a) {
    if (!isDeveloper()) {
      addMsg("assistant", "\u26a0\ufe0f Deleting pages needs developer access.");
      return;
    }
    const slug = String(a.slug || "").trim();
    const card = document.createElement("div");
    card.className = "chat-msg assistant chat-confirm";
    card.innerHTML =
      "<strong>Delete page</strong>" +
      '<div class="chat-confirm-row"><span>URL</span><b>/p/' +
      escapeHtml(slug) +
      "</b></div>" +
      '<div class="chat-confirm-actions">' +
      '<button type="button" class="btn ghost small" data-act="cancel">Cancel</button>' +
      '<button type="button" class="btn danger small" data-act="ok">Delete</button>' +
      "</div>";
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    card.querySelector('[data-act="cancel"]').addEventListener("click", () => card.remove());
    card.querySelector('[data-act="ok"]').addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = "Deleting\u2026";
      try {
        await api("/api/pages/" + encodeURIComponent(slug), {
          method: "DELETE",
          headers: { "Content-Type": "application/json", "x-dev-key": getDevKey() },
        });
        card.querySelector(".chat-confirm-actions").remove();
        addMsg("assistant", "\u{1F5D1}\uFE0F Deleted /p/" + slug + ".");
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Delete";
        addMsg("assistant", "\u26a0\ufe0f Couldn't delete: " + (err && err.message ? err.message : err));
      }
    });
  }

  function showBookingConfirm(a) {
    const cat = normalizeCategory(a.category);
    const catObj = PRICING.find((c) => c.id === cat);
    const card = document.createElement("div");
    card.className = "chat-msg assistant chat-confirm";
    card.innerHTML =
      "<strong>Review your registration</strong>" +
      row("Name", a.name) +
      row("Email", a.email) +
      row("Phone", a.phone) +
      row("Category", catObj ? catObj.name : a.category || "\u2014") +
      (catObj ? row("Amount", "\u20b9" + catObj.price) : "") +
      '<div class="chat-confirm-actions">' +
      '<button type="button" class="btn ghost small" data-act="cancel">Cancel</button>' +
      '<button type="button" class="btn primary small chat-confirm-ok" data-act="ok">Confirm &amp; register</button>' +
      "</div>";
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;

    function row(label, value) {
      return (
        '<div class="chat-confirm-row"><span>' +
        escapeHtml(label) +
        "</span><b>" +
        escapeHtml(value || "\u2014") +
        "</b></div>"
      );
    }

    card.querySelector('[data-act="cancel"]').addEventListener("click", () => {
      card.remove();
      addMsg("assistant", "No problem \u2014 tell me what you'd like to change.");
    });

    card.querySelector('[data-act="ok"]').addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = "Registering\u2026";
      if (!cat) {
        btn.disabled = false;
        btn.textContent = "Confirm & register";
        addMsg("assistant", "That category didn't match our list \u2014 which stay option would you like?");
        return;
      }
      try {
        const record = await api("/api/registrations", {
          method: "POST",
          body: JSON.stringify({
            name: a.name,
            email: a.email,
            phone: a.phone,
            categoryId: cat,
          }),
        });
        card.querySelector(".chat-confirm-actions").remove();
        btn.textContent = "Opening payment…";
        // Open Razorpay checkout; on success OR dismiss show the confirmation message.
        await openRazorpay(record, (r) => {
          const ref = "BC-" + String(r.id || "").slice(0, 8).toUpperCase();
          if (r.paid) {
            addMsg("assistant", "✅ Payment received! You're all set. Your reference is **" + ref + "**. See you at the convention! 🎉");
          } else {
            addMsg("assistant", "✅ You're registered! Your reference is **" + ref + "**. Complete your payment at your convenience — the team will confirm your spot once received.");
          }
        });
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Confirm & register";
        addMsg("assistant", "\u26a0\ufe0f Couldn't register: " + (err && err.message ? err.message : err));
      }
    });
  }
  // ---------------------------------------------------------------------------

  fab.addEventListener("click", () => (panel.hidden ? openChat() : closeChat()));
  document.getElementById("chatClose").addEventListener("click", closeChat);

  // While a reply is still streaming in, keep any [[ACTION]] payload (and a
  // possibly half-received "[[ACT" tail) off the screen — it's a machine
  // directive, not something the user should ever see.
  function visibleText(s) {
    const idx = s.indexOf("[[ACTION]]");
    if (idx !== -1) return s.slice(0, idx).trimEnd();
    for (let i = Math.min(9, s.length); i > 0; i--) {
      if ("[[ACTION]]".startsWith(s.slice(-i))) return s.slice(0, s.length - i);
    }
    return s;
  }

  // ---- Streaming sendToChat: tokens arrive live, TTS queued per sentence ----
  async function sendToChatStream(q, opts) {
    const voice = !!opts.voice;
    const mySpeakId = ++speakId;
    const typingEl = addMsg("assistant typing", "\u2026");
    let bubble = null;          // non-voice: plain element
    let voiceMascot = null;     // voice: { row, bot, txt } from addAssistantBubble
    let fullText = "", sentenceBuf = "", spokenText = "";
    const ttsQueue = [];
    let draining = false, anyQueued = false;

    if (voice) { speaking = true; pauseListening(); setVoiceStatus("thinking"); }

    // Voice mode: reveal text in sync with audio, using the mascot bubble.
    const revealChunk = (chunk) => {
      if (typingEl.parentNode) typingEl.remove();
      if (!voiceMascot) {
        // No "speaking" class — the voice visualizer bars are the only
        // speaking animation; the mascot stays still.
        voiceMascot = addAssistantBubble();
      }
      spokenText += (spokenText ? " " : "") + chunk;
      voiceMascot.txt.innerHTML = escapeHtml(spokenText).replace(/\n/g, "<br>");
      scrollToMsg(voiceMascot.row, "assistant");
    };
    const queueTts = (chunk) => {
      // Strip [[ACTION]] marker — never feed raw action JSON to TTS.
      const actionIdx = chunk.indexOf("[[ACTION]]");
      const text = (actionIdx !== -1 ? chunk.slice(0, actionIdx) : chunk).trim();
      if (!text || !voice) return;
      anyQueued = true;
      ttsQueue.push({ text, audioP: fetchTts(text) });
      if (!draining) drainTts();
    };
    const drainTts = async () => {
      draining = true;
      setVoiceStatus("speaking");
      while (ttsQueue.length) {
        const item = ttsQueue.shift();
        const audio64 = await item.audioP;
        if (mySpeakId !== speakId) { draining = false; return; }
        revealChunk(item.text); // show it right as it's about to be spoken
        if (audio64) await playClip(audio64, null, mySpeakId);
      }
      draining = false;
      if (mySpeakId === speakId) afterSpeak();
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          role: localStorage.getItem("role") || "user",
          devKey: getDevKey(),
          voice,
          stream: true,
        }),
      });
      if (!res.ok || !res.body) throw new Error("stream " + res.status);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", finalReply = null, sseError = null, replyDetail = null;

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const msg = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!msg.startsWith("data:")) continue;
          let data;
          try { data = JSON.parse(msg.slice(5).trim()); } catch { continue; }

          if (data.t) {
            fullText += data.t;
            sentenceBuf += data.t;
            if (!voice) {
              if (typingEl.parentNode) typingEl.remove();
              if (!bubble) bubble = addMsg("assistant", "");
              bubble.innerHTML = escapeHtml(visibleText(fullText)).replace(/\n/g, "<br>");
              log.scrollTop = log.scrollHeight;
            } else {
              // Speak+reveal one chunk at a time as generation continues.
              // Full sentences first; a long clause with no terminator yet
              // is flushed at a word boundary so audio doesn't wait for the
              // whole sentence to finish streaming in.
              for (;;) {
                const m = sentenceBuf.match(/^(.{15,}?[.!?])\s+([\s\S]*)$/);
                if (m) { queueTts(m[1]); sentenceBuf = m[2]; continue; }
                if (sentenceBuf.length > 90) {
                  const comma = sentenceBuf.lastIndexOf(", ", 90);
                  const cut = comma > 20 ? comma + 1 : sentenceBuf.lastIndexOf(" ", 90);
                  if (cut > 20) { queueTts(sentenceBuf.slice(0, cut)); sentenceBuf = sentenceBuf.slice(cut).trimStart(); continue; }
                }
                break;
              }
            }
          }
          if (data.done) finalReply = data.reply;
          if (data.detail) replyDetail = data.detail;
          if (data.error) { sseError = data.error; break outer; }
        }
      }

      // Real reason (all models failed) is always logged, and shown inline for
      // developers (dev key present) so "always resting" is never a mystery.
      if (replyDetail) {
        console.error("[chat/voice] server detail:", replyDetail);
        if (getDevKey()) addMsg("assistant", "\uD83D\uDEE0\ufe0f debug: " + replyDetail);
      }

      // SSE sent an error event (AI models unavailable) — show friendly message, not "network error".
      if (sseError) {
        if (typingEl.parentNode) typingEl.remove();
        if (voice) { if (voiceMascot) voiceMascot.row.remove(); } else { if (bubble) bubble.remove(); }
        if (voice) { speaking = false; afterSpeak(); }
        handleAssistantReply(
          "The assistant is resting for a moment \uD83D\uDE34. Please try again shortly \u2014 meanwhile you can sign up on the Register page or reach the organising committee.",
          false
        );
        return;
      }

      if (voice && sentenceBuf.trim()) queueTts(sentenceBuf.trim());
      if (!voice) typingEl.remove(); // voice mode: cleared by revealChunk() in sync with speech

      const replyText = finalReply || fullText;
      if (replyText) {
        // In voice mode the speech pipeline (drainTts) may still be mid-flight —
        // `anyQueued`/`draining` is the real signal, not `bubble` (which only
        // gets set once the first chunk's audio actually starts).
        if (voice ? anyQueued || draining : bubble) {
          const { message, action, html } = parseReply(replyText);
          if (voice) {
            history.push({ role: "assistant", content: replyText });
          } else {
            // Re-render with the clean message (no action markers) and keep
            // history consistent with handleAssistantReply, which stores the
            // shown text rather than the raw reply.
            const shown = message || "Okay.";
            history.push({ role: "assistant", content: shown });
            bubble.innerHTML = escapeHtml(shown).replace(/\n/g, "<br>");
            log.scrollTop = log.scrollHeight;
          }
          if (action) executeAction(action, html);
        } else {
          // Nothing was queued/shown/spoken yet (e.g. entire reply was inside
          // <think> blocks and got filtered out before reaching the client).
          // Route through the normal handler which does both and crucially
          // calls afterSpeak() to unlock voice mode.
          if (typingEl.parentNode) typingEl.remove();
          handleAssistantReply(replyText, voice);
        }
      } else if (buf.trim()) {
        // Plain-JSON response (local dev server doesn't send SSE) — parse and display it.
        try {
          const plain = JSON.parse(buf.trim());
          if (plain.reply) {
            // handleAssistantReply pushes to history itself — no push here.
            handleAssistantReply(plain.reply, voice);
          }
        } catch {}
      }
    } catch (err) {
      console.error("[stream]", err);
      typingEl.remove();
      if (voice) { if (voiceMascot) voiceMascot.row.remove(); } else { if (bubble) bubble.remove(); }
      if (voice) { speaking = false; afterSpeak(); }
      handleAssistantReply(
        "I couldn\u2019t reach the server just now \uD83D\uDCF6. Please check your connection and try again.",
        false
      );
    } finally {
      sendBtn.disabled = false;
      if (!isMobile() && !voice) text.focus();
    }
  }

  // ---- Send a message to the assistant (shared by typing and voice) --------
  async function sendToChat(q, opts) {
    opts = opts || {};
    q = (q || "").trim();
    if (!q) return;
    addMsg("user", q);
    history.push({ role: "user", content: q });
    lastUserText = q;
    sendBtn.disabled = true;
    // Typing and voice both use the streaming pipeline so tokens show up live
    // instead of waiting for the whole reply and then re-animating it.
    return sendToChatStream(q, opts);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = text.value.trim();
    if (!q) return;
    text.value = "";
    sendToChat(q, { voice: false });
  });

  // ---- Voice / talk mode (browser Web Speech API, no install needed) -------
  // Listen with SpeechRecognition, answer via the same /api/chat, then speak
  // the reply with speechSynthesis and resume listening — a hands-free loop.
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canListen = !!SpeechRec;
  const canSpeak = "speechSynthesis" in window;
  let voiceMode = false;
  let recognition = null;
  let recognizing = false;
  let speaking = false;
  let interimEl = null;
  let lastSpoken = "";
  // Drop any recognition results until this time (swallows the speaker echo
  // tail right after the bot stops talking).
  let ignoreResultsUntil = 0;
  // True from the moment we capture a phrase until the bot has finished
  // answering + speaking. Blocks new input so mobile can't stack prompts.
  let processing = false;
  // Speech is committed only after a short silence, so we capture the whole
  // sentence instead of just the first word.
  let finalBuffer = "";
  let lastInterim = "";
  let silenceTimer = null;

  // Normalise text so we can tell the user's speech apart from the bot's own
  // voice echoing back through the speakers.
  function normalizeSpeech(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- Real-time voice visualizer (Gemini-style reactive bars) -------------
  // The bars are driven by GENUINE audio levels via the Web Audio API: the
  // microphone stream while the user is talking, the TTS clip while the bot is
  // talking. speechSynthesis exposes no audio graph, and a denied mic can't be
  // analysed either — those cases fall back to a CSS keyframe animation.
  const vizEl = document.getElementById("voiceViz");
  const vizBars = vizEl ? Array.prototype.slice.call(vizEl.children) : [];
  let vizAC = null, micAnalyser = null, ttsAnalyser = null;
  let micStream = null, micSource = null, vizRaf = 0;
  let vizState = ""; // mirrors the latest setVoiceStatus state
  let ttsLive = false; // true when the current speech is analyser-driven
  const vizLevels = vizBars.map(() => 0);
  let vizData = null; // shared FFT buffer, allocated once

  function vizContext() {
    if (!vizAC) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      vizAC = new AC();
    }
    if (vizAC.state === "suspended") vizAC.resume().catch(() => {});
    return vizAC;
  }

  function makeAnalyser(ctx) {
    const a = ctx.createAnalyser();
    a.fftSize = 256;
    a.smoothingTimeConstant = 0.55;
    return a;
  }

  async function vizAttachMic() {
    const ctx = vizContext();
    if (!ctx || micSource || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micAnalyser = makeAnalyser(ctx);
      micSource = ctx.createMediaStreamSource(micStream);
      micSource.connect(micAnalyser); // analysis only — never routed to speakers
    } catch (e) {
      /* mic denied for analysis — bars fall back to the CSS animation */
    }
  }

  function vizDetachMic() {
    try { if (micSource) micSource.disconnect(); } catch (e) {}
    try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    micSource = null; micStream = null; micAnalyser = null;
  }

  // Route a TTS <audio> element through the analyser so the bars move with the
  // bot's actual voice. The analyser passes audio on to the speakers.
  function vizAttachAudio(audioEl) {
    const ctx = vizContext();
    if (!ctx) return;
    try {
      if (!ttsAnalyser) {
        ttsAnalyser = makeAnalyser(ctx);
        ttsAnalyser.connect(ctx.destination);
      }
      ctx.createMediaElementSource(audioEl).connect(ttsAnalyser);
      ttsLive = true;
    } catch (e) {
      /* already attached or unsupported — the clip still plays normally */
    }
  }

  // Five symmetric frequency bands (center = low-mids where voices live) so
  // each bar dances independently, like Gemini's waveform.
  const VIZ_BANDS = [[24, 48], [10, 24], [2, 10], [10, 24], [24, 48]];

  function vizFrame() {
    vizRaf = requestAnimationFrame(vizFrame);
    if (!vizEl) return;
    const analyser =
      vizState === "speaking" ? (ttsLive ? ttsAnalyser : null) :
      vizState === "listening" ? micAnalyser : null;
    const live = !!(analyser && vizAC && vizAC.state === "running");
    vizEl.classList.toggle("live", live);
    if (!live) return; // CSS keyframes take over for this state
    if (!vizData) vizData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(vizData);
    for (let i = 0; i < vizBars.length; i++) {
      const band = VIZ_BANDS[i] || VIZ_BANDS[0];
      let sum = 0;
      for (let b = band[0]; b < band[1]; b++) sum += vizData[b] || 0;
      const target = Math.min(1, (sum / (band[1] - band[0]) / 255) * 1.6);
      // Fast attack, gentle decay — snappy but never jittery.
      vizLevels[i] = target > vizLevels[i] ? target : vizLevels[i] * 0.8;
      vizBars[i].style.height = (5 + vizLevels[i] * 21).toFixed(1) + "px";
    }
  }

  function vizStart() {
    if (!vizRaf) vizFrame();
  }

  function vizStop() {
    if (vizRaf) cancelAnimationFrame(vizRaf);
    vizRaf = 0;
    if (vizEl) vizEl.classList.remove("live");
    for (let i = 0; i < vizBars.length; i++) {
      vizLevels[i] = 0;
      vizBars[i].style.height = "";
    }
  }

  function setVoiceStatus(state) {
    vizState = state;
    if (micBtn) {
      micBtn.classList.toggle("active", voiceMode);
      micBtn.classList.toggle("listening", voiceMode && state === "listening");
      micBtn.classList.toggle("speaking", voiceMode && state === "speaking");
    }
    const chatAvatar = document.getElementById("chatAvatar");
    if (chatAvatar) {
      // The visualizer bars are the speaking animation — the header mascot
      // stays still while the bot talks (only "thinking" still shows).
      chatAvatar.classList.remove("talking");
      chatAvatar.classList.toggle("thinking", voiceMode && state === "thinking");
    }
    if (panel) {
      // Soft ambient glow on the whole panel while talk mode is on.
      panel.classList.toggle("voice-open", voiceMode);
      panel.classList.toggle("voice-speaking", voiceMode && state === "speaking");
    }
    if (!voiceBar) return;
    voiceBar.hidden = !voiceMode;
    voiceBar.classList.toggle("is-listening", state === "listening");
    voiceBar.classList.toggle("is-speaking", state === "speaking");
    voiceBar.classList.toggle("is-thinking", state === "thinking");
    if (voiceLabel) {
      voiceLabel.textContent =
        state === "listening"
          ? "Listening\u2026"
          : state === "speaking"
          ? "Speaking\u2026"
          : state === "thinking"
          ? "Thinking\u2026"
          : "Talk mode on";
    }
  }

  // Pick the most natural-sounding English voice the browser offers, instead of
  // the default robotic one. Neural/Online voices (Edge) and Google voices sound
  // far better. Cached once voices are loaded (they load asynchronously).
  let preferredVoice = null;
  let voicesReady = false;
  function pickPreferredVoice() {
    if (!canSpeak) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || !voices.length) return null;
    voicesReady = true;
    const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang || ""));
    const pool = en.length ? en : voices;
    const score = (v) => {
      const n = (v.name || "").toLowerCase();
      let s = 0;
      if (/natural|neural|online/.test(n)) s += 100; // Edge neural voices
      if (/google/.test(n)) s += 60; // Chrome/Android Google voices
      if (/\baria|jenny|libby|sonia|emma|michelle|ava|neerja|prabhat\b/.test(n)) s += 40;
      if (/female|woman/.test(n)) s += 8;
      if (/en-in/i.test(v.lang || "")) s += 12; // prefer Indian English
      else if (/en-gb/i.test(v.lang || "")) s += 6;
      if (v.localService) s += 2;
      return s;
    };
    pool.sort((a, b) => score(b) - score(a));
    preferredVoice = pool[0] || null;
    return preferredVoice;
  }
  if (canSpeak) {
    pickPreferredVoice();
    // Voices often aren't ready on first call; refresh when they load.
    try {
      window.speechSynthesis.onvoiceschanged = pickPreferredVoice;
    } catch (e) {}
  }

  // Speak the assistant's visible message. The mic is turned OFF while the bot
  // talks so it can't hear itself through the speakers and answer its own voice.
  // We always prefer the server's neural TTS (much more natural); if a given
  // request fails we fall back to the browser voice JUST for that message (we no
  // longer disable neural TTS for the whole session, so it stays consistent).
  // onStart() runs the moment audio actually begins, so the on-screen text can
  // be shown in sync with the voice.
  let currentAudio = null;

  function speak(msg, onStart) {
    let started = false;
    const startOnce = () => {
      if (started) return;
      started = true;
      try {
        onStart && onStart();
      } catch (e) {}
    };
    if (!msg) {
      startOnce();
      afterSpeak();
      return;
    }
    speaking = true;
    speakId++; // invalidate any in-flight chunk playback from a previous turn
    pauseListening(); // mic off while we talk
    setVoiceStatus("speaking");
    // Safety net: reveal text if audio hasn't started yet (Aura-2 is slower
    // than local TTS, so 4.5 s gives it time to respond before we give up).
    const capTimer = setTimeout(startOnce, 4500);
    const begin = () => {
      clearTimeout(capTimer);
      startOnce();
    };
    serverSpeak(msg, begin);
  }

  // High-quality neural voice from the Worker (Cloudflare MeloTTS).
  // To cut the wait, we speak in CHUNKS: the first sentence is generated and
  // played almost immediately, while the rest is fetched in the background and
  // queued right behind it. Time-to-first-word drops from "whole reply" to
  // "one short sentence".
  let speakId = 0;

  function splitForSpeech(msg) {
    const text = String(msg || "").replace(/\s+/g, " ").trim();
    if (!text) return [];
    const sentences = (text.match(/[^.!?]+[.!?]*/g) || [text])
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length <= 1) return [text.slice(0, 800)];
    // First chunk = just the opening sentence (fast to synthesise); the rest
    // becomes a second chunk so we make at most two TTS calls.
    const first = sentences[0].slice(0, 180); // shorter = faster first TTS response
    const rest = sentences.slice(1).join(" ").slice(0, 700);
    return rest ? [first, rest] : [first];
  }

  // Prepare text for neural TTS: strip emojis and normalise informal spellings
  // that TTS engines either skip or mispronounce badly.
  function sanitizeForTts(raw) {
    return String(raw || "")
      // Strip markdown bold / italic / inline-code
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/`(.+?)`/g, "$1")
      // Drop all emoji (covers BMP misc-symbols + supplementary emoji planes)
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
      .replace(/[\u{2600}-\u{27FF}]/gu, "")
      .replace(/\uFE0F/gu, "")   // variation selector
      .replace(/\u20E3/gu, "")   // combining enclosing keycap
      // Normalise informal words → pronounceable equivalents
      .replace(/\bayyo\b/gi, "ayo")
      .replace(/\bokk+\b/gi, "okay")
      .replace(/\byoo+\b/gi, "yo")
      .replace(/\bngl\b/gi, "")
      .replace(/\bfr\b/gi, "")
      .replace(/\brn\b/gi, "right now")
      .replace(/\bidk\b/gi, "I don't know")
      .replace(/\btbh\b/gi, "to be honest")
      .replace(/\blmao\b/gi, "")
      .replace(/\blol\b/gi, "")
      .replace(/\bomg\b/gi, "oh my god")
      .replace(/\bbro\b/gi, "bro")   // kept — Deepgram handles it fine
      // Tidy up whitespace left behind by removed tokens
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  async function fetchTts(textPart) {
    const clean = sanitizeForTts(textPart);
    if (!clean) return null;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return data.audio || null;
    } catch (e) {
      return null;
    }
  }

  // Pre-warm the greeting TTS only once the user shows intent to chat (hover
  // or open) instead of paying a Deepgram synthesis on every page load.
  function startPrewarm() {
    if (prewarmAudioP || isDeveloper() || isAdmin()) return;
    prewarmAudioP = fetchTts(prewarmGreetingText);
  }
  fab.addEventListener("pointerenter", startPrewarm, { once: true });
  fab.addEventListener("touchstart", startPrewarm, { once: true, passive: true });

  function playClip(audio64, onStart, myId) {
    return new Promise((resolve) => {
      if (myId !== speakId) return resolve(); // a newer utterance took over
      try {
        window.speechSynthesis && window.speechSynthesis.cancel();
      } catch (e) {}
      const audio = new Audio("data:audio/mp3;base64," + audio64);
      currentAudio = audio;
      // Talk mode: drive the visualizer bars with this clip's real levels.
      if (voiceMode) vizAttachAudio(audio);
      audio.onplay = () => onStart && onStart();
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
    });
  }

  async function serverSpeak(msg, begin) {
    const myId = speakId;
    const chunks = splitForSpeech(msg);
    if (!chunks.length) {
      begin && begin();
      afterSpeak();
      return;
    }
    // Prefetch the first chunk; then loop, prefetching the next while the
    // current one plays so playback is gapless.
    let nextAudio = fetchTts(chunks[0]);
    for (let i = 0; i < chunks.length; i++) {
      if (myId !== speakId) return; // stopped or superseded
      const audio64 = await nextAudio;
      nextAudio = i + 1 < chunks.length ? fetchTts(chunks[i + 1]) : Promise.resolve(null);
      if (!audio64) {
        // This chunk failed -> speak the remainder with the browser voice.
        browserSpeak(chunks.slice(i).join(" "), i === 0 ? begin : null);
        return;
      }
      await playClip(audio64, i === 0 ? begin : null, myId);
    }
    if (myId === speakId) afterSpeak();
  }

  // Fallback: browser speechSynthesis with the best available voice.
  function browserSpeak(msg, begin) {
    ttsLive = false; // no audio graph here — visualizer uses its CSS animation
    if (!canSpeak) {
      begin && begin();
      afterSpeak();
      return;
    }
    try {
      window.speechSynthesis.cancel();
    } catch (e) {}
    if (!preferredVoice && !voicesReady) pickPreferredVoice();
    const u = new SpeechSynthesisUtterance(msg);
    if (preferredVoice) {
      u.voice = preferredVoice;
      u.lang = preferredVoice.lang || "en-IN";
    } else {
      u.lang = "en-IN";
    }
    u.rate = 1; // natural pace
    u.pitch = 1.05; // slightly warmer
    u.volume = 1;
    u.onstart = () => begin && begin();
    u.onend = afterSpeak;
    u.onerror = afterSpeak;
    // onstart doesn't always fire; reveal the text shortly after as a backup.
    setTimeout(() => begin && begin(), 300);
    try {
      window.speechSynthesis.speak(u);
    } catch (e) {
      begin && begin();
      afterSpeak();
    }
  }

  function afterSpeak() {
    speaking = false;
    processing = false; // ready for the next phrase
    // Ignore the echo tail for a moment, then start listening again.
    ignoreResultsUntil = Date.now() + 500;
    if (voiceMode) {
      setVoiceStatus("listening");
      setTimeout(() => {
        if (voiceMode && !speaking && !processing) startListening();
      }, 250);
    } else {
      setVoiceStatus("");
    }
  }

  // Immediately silence the bot (used by the Stop button).
  function stopSpeaking() {
    if (!speaking) return;
    speaking = false;
    processing = false;
    speakId++; // abort any queued/in-flight chunk playback
    try {
      if (currentAudio) {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
        currentAudio = null;
      }
    } catch (e) {}
    try {
      if (canSpeak) window.speechSynthesis.cancel();
    } catch (e) {}
    ignoreResultsUntil = Date.now() + 300;
    if (voiceMode) {
      setVoiceStatus("listening");
      setTimeout(() => {
        if (voiceMode && !speaking && !processing) startListening();
      }, 200);
    }
  }

  // Stop the mic (used while the bot is speaking).
  function pauseListening() {
    if (!recognition) return;
    try {
      recognition.stop();
    } catch (e) {}
  }

  function startListening() {
    if (!voiceMode || !canListen || recognizing || speaking || processing) return;
    try {
      recognition.start();
    } catch (e) {
      /* start() throws if already started; ignore */
    }
  }

  function showInterim(t) {
    if (!interimEl) {
      interimEl = document.createElement("div");
      interimEl.className = "chat-msg user interim";
      log.appendChild(interimEl);
    }
    interimEl.textContent = t;
    log.scrollTop = log.scrollHeight;
  }

  function clearInterim() {
    if (interimEl) {
      interimEl.remove();
      interimEl = null;
    }
  }

  // Send the accumulated phrase once the user has paused. This is the single
  // point that locks input and fires the request, so it can't double up.
  function commitPhrase() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    const said = (finalBuffer + " " + lastInterim).replace(/\s+/g, " ").trim();
    finalBuffer = "";
    lastInterim = "";
    if (!said || processing || speaking) return;
    clearInterim();
    processing = true; // lock: no more input until we've answered + spoken
    pauseListening(); // stop the mic while we answer
    setVoiceStatus("thinking");
    sendToChat(said, { voice: true });
  }

  function initRecognition() {
    recognition = new SpeechRec();
    recognition.lang = "en-IN";
    recognition.interimResults = true;
    // One utterance per listen session. Continuous mode kept a cumulative
    // results array that duplicated words across events; this avoids that.
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      recognizing = true;
      // Fresh session -> start with an empty transcript so nothing carries over.
      finalBuffer = "";
      lastInterim = "";
      if (!speaking) setVoiceStatus("listening");
    };

    recognition.onresult = (ev) => {
      // Ignore anything heard while the bot is talking, still answering, or in
      // the echo-tail window. This is what stops mobile stacking prompts.
      if (speaking || processing || Date.now() < ignoreResultsUntil) {
        clearInterim();
        return;
      }
      let interim = "";
      let finalText = "";
      // Rebuild from the FULL results list each time (don't append incrementally,
      // or repeated onresult events duplicate words -> "what what are are").
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript + " ";
        else interim += r[0].transcript + " ";
      }
      finalBuffer = finalText;
      lastInterim = interim;

      const shown = (finalBuffer + interim).replace(/\s+/g, " ").trim();
      if (shown) showInterim(shown);

      // Backup: if the recognizer keeps the session open, send after a pause.
      // (The primary commit happens on onend when the utterance finishes.)
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(commitPhrase, 1400);
    };

    recognition.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        recognizing = false;
        voiceMode = false;
        stopSpeaking();
        setVoiceStatus("");
        addMsg(
          "assistant",
          "\u26a0\ufe0f I couldn't use the microphone. Please allow mic access in your browser, then tap the mic again."
        );
      }
      // 'no-speech' / 'aborted' fall through; onend restarts listening.
    };

    recognition.onend = () => {
      recognizing = false;
      // If the user finished a phrase (recognizer stopped on its own), send it.
      if ((finalBuffer.trim() || lastInterim.trim()) && !processing && !speaking) {
        commitPhrase();
        return;
      }
      // Only auto-restart when we're not paused for speech or a pending answer.
      if (voiceMode && !speaking && !processing) {
        setTimeout(() => {
          if (voiceMode && !speaking && !processing && !recognizing) startListening();
        }, 200);
      }
    };
  }

  function startVoiceMode() {
    if (!canListen) {
      if (panel.hidden) openChat();
      addMsg(
        "assistant",
        "\u26a0\ufe0f Voice input isn't supported in this browser \u2014 try Chrome or Edge."
      );
      return;
    }
    if (!recognition) initRecognition();
    if (panel.hidden) openChat();
    voiceMode = true;
    processing = false;
    speaking = false;
    finalBuffer = "";
    lastInterim = "";
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    setVoiceStatus("listening");
    startListening();
    // Live visualizer: analyse the mic (separately from SpeechRecognition) so
    // the bars move with the user's actual voice.
    vizAttachMic();
    vizStart();
  }

  function stopVoiceMode() {
    if (!voiceMode && !recognizing && !speaking) return;
    voiceMode = false;
    try {
      recognition && recognition.stop();
    } catch (e) {}
    try {
      if (currentAudio) {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
        currentAudio = null;
      }
    } catch (e) {}
    try {
      if (canSpeak) window.speechSynthesis.cancel();
    } catch (e) {}
    speaking = false;
    processing = false;
    finalBuffer = "";
    lastInterim = "";
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    clearInterim();
    setVoiceStatus("");
    vizStop();
    vizDetachMic();
  }

  function toggleVoiceMode() {
    if (voiceMode) stopVoiceMode();
    else startVoiceMode();
  }

  if (micBtn) {
    if (!canListen && !canSpeak) micBtn.hidden = true;
    micBtn.addEventListener("click", toggleVoiceMode);
  }
  const voiceStopBtn = document.getElementById("chatVoiceStop");
  if (voiceStopBtn) voiceStopBtn.addEventListener("click", stopVoiceMode);
}

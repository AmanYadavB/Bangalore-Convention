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

// ---- AI chat assistant (Cloudflare Workers AI on the live site) ----
function mountChat() {
  if (document.getElementById("chatWidget")) return;

  const wrap = document.createElement("div");
  wrap.id = "chatWidget";
  wrap.className = "chat-widget";
  wrap.innerHTML = `
    <button class="chat-fab" id="chatFab" type="button" aria-label="Open chat" title="Ask a question">
      <span class="chat-fab-icon">\uD83D\uDCAC</span>
    </button>
    <section class="chat-panel" id="chatPanel" aria-live="polite" hidden>
      <header class="chat-head">
        <div>
          <strong>Convention Helper</strong>
          <small>Ask about registration &amp; pricing</small>
        </div>
        <button class="chat-close" id="chatClose" type="button" aria-label="Close chat">\u00d7</button>
      </header>
      <div class="chat-log" id="chatLog"></div>
      <div class="chat-voice" id="chatVoice" hidden>
        <span class="chat-voice-dot"></span>
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
    el.innerHTML = escapeHtml(content).replace(/\n/g, "<br>");
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
    panel.hidden = false;
    fab.classList.add("open");
    if (!greeted) {
      greeted = true;
      const greeting = isDeveloper()
        ? "Hi developer! Ask me anything about registrations, money and expenses. Anything you add on the Feed AI page becomes part of what I know."
        : isAdmin()
        ? "Hi! Ask me about registrations, payments collected, pending amounts or expenses \u2014 I have the live numbers."
        : "Hi! I can help with registration, pricing, dates and what's included. What would you like to know?";
      addMsg("assistant", greeting);
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
    addMsg("assistant", shown);
    history.push({ role: "assistant", content: shown });
    if (voice) speak(shown);
    if (action) executeAction(action, html);
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
        const ref = "BC-" + String(record.id || "").slice(0, 8).toUpperCase();
        card.querySelector(".chat-confirm-actions").remove();
        addMsg(
          "assistant",
          "\u2705 You're registered! Your reference is " +
            ref +
            ". The team will confirm your payment shortly."
        );
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

  // ---- Send a message to the assistant (shared by typing and voice) --------
  async function sendToChat(q, opts) {
    opts = opts || {};
    q = (q || "").trim();
    if (!q) return;
    addMsg("user", q);
    history.push({ role: "user", content: q });
    lastUserText = q;
    sendBtn.disabled = true;
    const typing = addMsg("assistant typing", "\u2026");
    console.log("[chat] POST /api/chat", { messages: history });
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          role: localStorage.getItem("role") || "user",
          devKey: getDevKey(),
        }),
      });
      const raw = await res.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch (parseErr) {
        console.error("[chat] response was not JSON:", raw);
      }
      typing.remove();

      if (!res.ok) {
        const detail =
          data.error || data.message || raw || res.statusText || "Unknown error";
        console.error("[chat] request failed", res.status, detail);
        addMsg("assistant", "\u26a0\ufe0f Chat failed (HTTP " + res.status + "): " + detail);
        if (opts.voice) afterSpeak();
        return;
      }

      const reply = data.reply || "Sorry, I couldn't answer that.";
      handleAssistantReply(reply, opts.voice);
    } catch (err) {
      console.error("[chat] network/exception error:", err);
      typing.remove();
      addMsg(
        "assistant",
        "\u26a0\ufe0f Could not reach the chat server: " +
          (err && err.message ? err.message : err)
      );
      if (opts.voice) afterSpeak();
    } finally {
      sendBtn.disabled = false;
      // On mobile, don't re-focus after reply — that would re-open the keyboard.
      if (!isMobile() && !opts.voice) text.focus();
    }
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

  // Normalise text so we can tell the user's speech apart from the bot's own
  // voice echoing back through the speakers.
  function normalizeSpeech(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function setVoiceStatus(state) {
    if (micBtn) {
      micBtn.classList.toggle("active", voiceMode);
      micBtn.classList.toggle("listening", voiceMode && state === "listening");
      micBtn.classList.toggle("speaking", voiceMode && state === "speaking");
    }
    if (!voiceBar) return;
    voiceBar.hidden = !voiceMode;
    voiceBar.classList.toggle("is-listening", state === "listening");
    voiceBar.classList.toggle("is-speaking", state === "speaking");
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

  // Speak the assistant's visible message. The mic is turned OFF while the bot
  // talks so it can't hear itself through the speakers and answer its own voice.
  function speak(msg) {
    if (!canSpeak || !msg) {
      afterSpeak();
      return;
    }
    speaking = true;
    pauseListening(); // mic off while we talk
    try {
      window.speechSynthesis.cancel();
    } catch (e) {}
    const u = new SpeechSynthesisUtterance(msg);
    u.lang = "en-IN";
    u.rate = 1.02;
    u.pitch = 1;
    setVoiceStatus("speaking");
    u.onend = afterSpeak;
    u.onerror = afterSpeak;
    try {
      window.speechSynthesis.speak(u);
    } catch (e) {
      afterSpeak();
    }
  }

  function afterSpeak() {
    if (!speaking) return; // already handled (onend + onerror can both fire)
    speaking = false;
    // Ignore the echo tail for a moment, then start listening again.
    ignoreResultsUntil = Date.now() + 500;
    if (voiceMode) {
      setVoiceStatus("listening");
      setTimeout(() => {
        if (voiceMode && !speaking) startListening();
      }, 250);
    } else {
      setVoiceStatus("");
    }
  }

  // Immediately silence the bot (used by the Stop button).
  function stopSpeaking() {
    if (!speaking) return;
    speaking = false;
    try {
      if (canSpeak) window.speechSynthesis.cancel();
    } catch (e) {}
    ignoreResultsUntil = Date.now() + 300;
    if (voiceMode) {
      setVoiceStatus("listening");
      setTimeout(() => {
        if (voiceMode && !speaking) startListening();
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
    if (!voiceMode || !canListen || recognizing || speaking) return;
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

  function initRecognition() {
    recognition = new SpeechRec();
    recognition.lang = "en-IN";
    recognition.interimResults = true;
    recognition.continuous = true; // stay live for the whole session
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      recognizing = true;
      if (!speaking) setVoiceStatus("listening");
    };

    recognition.onresult = (ev) => {
      // Ignore anything heard while the bot is talking or in the echo-tail window.
      if (speaking || Date.now() < ignoreResultsUntil) {
        clearInterim();
        return;
      }
      let interim = "";
      let finalText = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }

      if (interim) showInterim(interim);

      const said = finalText.trim();
      if (said) {
        clearInterim();
        setVoiceStatus("thinking");
        sendToChat(said, { voice: true });
      }
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
      // Only auto-restart when we're not deliberately paused for the bot's speech.
      if (voiceMode && !speaking) {
        setTimeout(() => {
          if (voiceMode && !speaking && !recognizing) startListening();
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
    setVoiceStatus("listening");
    startListening();
  }

  function stopVoiceMode() {
    if (!voiceMode && !recognizing && !speaking) return;
    voiceMode = false;
    try {
      recognition && recognition.stop();
    } catch (e) {}
    try {
      if (canSpeak) window.speechSynthesis.cancel();
    } catch (e) {}
    speaking = false;
    clearInterim();
    setVoiceStatus("");
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

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
  return localStorage.getItem("role") === "admin";
}

function login() {
  localStorage.setItem("role", "admin");
  location.reload();
}

function logout() {
  localStorage.removeItem("role");
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
  ].filter((l) => !l.admin || admin);

  const authBtn = admin
    ? `<button class="btn small auth-btn" id="authBtn" type="button">Logout</button>`
    : `<button class="btn primary small auth-btn" id="authBtn" type="button">Login</button>`;

  return `
  <nav class="nav">
    <a class="brand" href="index.html">
      <span class="logo">AA</span>
      <span>Bangalore Convention
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
      <form class="chat-input" id="chatForm">
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
  let greeted = false;

  function addMsg(kind, content) {
    const el = document.createElement("div");
    el.className = "chat-msg " + kind;
    el.innerHTML = escapeHtml(content).replace(/\n/g, "<br>");
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function openChat() {
    panel.hidden = false;
    fab.classList.add("open");
    if (!greeted) {
      greeted = true;
      addMsg(
        "assistant",
        "Hi! I can help with registration, pricing, dates and what's included. What would you like to know?"
      );
    }
    setTimeout(() => text.focus(), 50);
  }

  function closeChat() {
    panel.hidden = true;
    fab.classList.remove("open");
  }

  fab.addEventListener("click", () => (panel.hidden ? openChat() : closeChat()));
  document.getElementById("chatClose").addEventListener("click", closeChat);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = text.value.trim();
    if (!q) return;
    addMsg("user", q);
    history.push({ role: "user", content: q });
    text.value = "";
    sendBtn.disabled = true;
    const typing = addMsg("assistant typing", "\u2026");
    try {
      const data = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages: history }),
      });
      typing.remove();
      const reply = data.reply || "Sorry, I couldn't answer that.";
      addMsg("assistant", reply);
      history.push({ role: "assistant", content: reply });
    } catch (err) {
      typing.remove();
      addMsg("assistant", "Sorry, I'm having trouble right now. Please try again in a moment.");
    } finally {
      sendBtn.disabled = false;
      text.focus();
    }
  });
}

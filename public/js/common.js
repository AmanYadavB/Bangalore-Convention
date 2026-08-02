// Shared helpers for all pages.

// ---- Theme ----
function currentTheme() {
  return localStorage.getItem("theme") || "daylight";
}

function applyTheme(name) {
  document.documentElement.setAttribute("data-theme", name);
  localStorage.setItem("theme", name);
  // The theme control is the brand logo itself; the small corner badge on it
  // shows the theme a tap would switch TO.
  const hint = document.querySelector("#themeToggle .theme-hint");
  if (hint) hint.textContent = name === "daylight" ? "\uD83C\uDF19" : "\u2600\uFE0F";
}

function toggleTheme() {
  applyTheme(currentTheme() === "midnight" ? "daylight" : "midnight");
}

// Apply the saved theme as early as possible.
applyTheme(currentTheme());

const money = (n) =>
  "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

// Read a cookie by name. Used only for the CSRF token, which is deliberately
// NOT HttpOnly so it can be echoed back in a header. The session cookie is
// HttpOnly and is never visible here.
function readCookie(name) {
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + name.replace(/([.*+?^${}()|[\]\\])/g, "\\$1") + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[1]) : "";
}

function csrfToken() {
  // __Host- prefixed in production; plain over http on localhost, where
  // browsers reject Secure cookies.
  return readCookie("__Host-bc_csrf") || readCookie("bc_csrf");
}

async function api(path, options) {
  const opts = { credentials: "same-origin", ...options };
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };

  // Mutations carry the session-bound CSRF token. The server compares it
  // against the session row, not against the cookie, so it cannot be forged.
  const method = String(opts.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const token = csrfToken();
    if (token) headers["X-CSRF-Token"] = token;
  }
  opts.headers = headers;

  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    // Session expired or absent — bounce to login, remembering where we were.
    clearUserHint();
    const here = location.pathname + location.search;
    if (!location.pathname.endsWith("/login.html") && !location.pathname.endsWith("/login")) {
      location.href = "/login.html?e=session&next=" + encodeURIComponent(here);
    }
    throw new Error(data.error || "Please sign in.");
  }
  if (!res.ok)
    throw new Error(
      data.error || "something broke and even the mascot doesn't know what — try that again in a sec"
    );
  return data;
}

// ---- The mascot, in any of its moods --------------------------------------
// The FULL chat-button robot (antenna, blinking eyes, gradient body, arms,
// dangling legs). Moods: happy, dance, sad, worried, wave; scene-jump for
// victory moments. Used by toasts, confirm dialogs, the celebration card and
// the auth pages so the same character reacts to everything on the site.
function mascotHTML(mood) {
  return (
    '<span class="ebot ' + (mood || "happy") + '" aria-hidden="true">' +
    '<span class="eb-antenna"></span>' +
    '<span class="eb-head"><i class="eb-eye"></i><i class="eb-eye"></i>' +
    '<i class="eb-tear l"></i><i class="eb-tear r"></i><i class="eb-sweat"></i>' +
    '<span class="eb-mouth"></span></span>' +
    '<span class="eb-body"></span>' +
    '<span class="eb-arm l"></span><span class="eb-arm r"></span>' +
    '<span class="eb-legs"><i></i><i></i></span>' +
    "</span>"
  );
}

// The big centred version for dialogs and full pages (confetti when dancing).
function mascotStage(mood) {
  return (
    '<span class="mascot-stage' + (mood === "dance" ? " party" : "") + '">' +
    '<span class="mascot-scale">' + mascotHTML(mood) + "</span></span>"
  );
}

// Toast — the spotlight card. The page dims, the corner mascot leaves its
// button and rides the announcement in at eye level. Outcome-coloured:
// green (success/party), red (error), amber (info). Same signature as ever:
// toast(message, type) with type success (default) / error / info / party.
//
// The "always completes, never waits" rule: an announcement always finishes
// gracefully — if a new message arrives mid-show, the current one
// fast-forwards to its finished state (full text, quick exit) and the next
// starts immediately. Clicking the card counts as "read". The dim never
// blocks the page underneath.
let __toast = null; // { my, finishFast(next) }
let __toastSeq = 0;

function toast(message, type = "success") {
  const begin = () => __toastShow(String(message || ""), type);
  if (__toast) return __toast.finishFast(begin);
  begin();
}

function __toastShow(text, type) {
  const my = ++__toastSeq;
  const T =
    type === "error"
      ? { cls: "bad", chip: "✕", mood: "sad", title: "that didn't work" }
      : type === "info"
      ? { cls: "warn", chip: "!", mood: "worried", title: "heads up" }
      : type === "party"
      ? { cls: "good", chip: "✓", mood: "dance", title: "LET'S GOOOO!! 🎉" }
      : { cls: "good", chip: "✓", mood: "happy", title: "" };

  const fab = document.getElementById("chatFab");
  const chatOpen = document.body.classList.contains("chat-open");
  // ONE mascot rule: the rider is the corner mascot, moved onto the card. If
  // it's visibly busy elsewhere (flying a loop, grown huge) or the chat panel
  // is open, the card goes out plain — never two robots on screen.
  const mascotBusy = fab && (fab.classList.contains("flying") || fab.classList.contains("huge"));
  const rider = !chatOpen && !mascotBusy;
  const dimmed = !chatOpen;

  // Park the corner button and hold the mascot's scene loop while it's away.
  if (rider && fab) {
    fab.classList.remove("waving", "rolling", "jumping");
    fab.classList.add("away");
    window.__mascotSayUntil = Date.now() + 1200 + text.length * 17 + 4600 + 800;
  }

  let dim = null;
  if (dimmed) {
    dim = document.createElement("div");
    dim.className = "toast-dim";
    document.body.appendChild(dim);
    requestAnimationFrame(() => dim.classList.add("on"));
  }

  const card = document.createElement("div");
  card.className = "toastcard " + T.cls + (chatOpen ? " quiet" : "");
  card.innerHTML =
    (rider ? '<span class="rider">' + mascotHTML(T.mood) + "</span>" : "") +
    (T.title ? '<b class="ct-title"></b>' : "") +
    '<div class="amsg"><span class="chip">' + T.chip + "</span>" +
    '<div><span class="ct-msg"></span><span class="type-caret"></span>' +
    (type === "party" ? '<span class="burst"></span>' : "") +
    "</div></div>" +
    '<div class="life"></div>';
  if (T.title) card.querySelector(".ct-title").textContent = T.title;
  document.body.appendChild(card);
  setTimeout(() => card.classList.add("in"), 30);

  // Party: one-shot confetti burst out of the card.
  if (type === "party") {
    const burst = card.querySelector(".burst");
    const colors = ["#10b981", "#5b5bf0", "#7c3aed", "#0ea5e9", "#f59e0b", "#ef4444"];
    for (let i = 0; i < 10; i++) {
      const p = document.createElement("i");
      const ang = (i / 10) * Math.PI * 2;
      p.style.setProperty("--bx", Math.round(Math.cos(ang) * (60 + Math.random() * 40)) + "px");
      p.style.setProperty("--by", Math.round(Math.sin(ang) * (40 + Math.random() * 30) - 20) + "px");
      p.style.setProperty("--br", Math.round(Math.random() * 500 - 250) + "deg");
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = 0.15 + Math.random() * 0.15 + "s";
      burst.appendChild(p);
    }
  }

  const msgEl = card.querySelector(".ct-msg");
  const timers = [];
  let typeTimer = 0;
  let closed = false;

  const cleanup = () => {
    card.remove();
    if (dim) {
      dim.classList.remove("on");
      setTimeout(() => dim.remove(), 350);
    }
    if (rider && fab) fab.classList.remove("away");
    if (my === __toastSeq) window.__mascotSayUntil = 0;
    if (__toast && __toast.my === my) __toast = null;
  };

  const exit = (fast, next) => {
    if (closed) return;
    closed = true;
    timers.forEach(clearTimeout);
    clearInterval(typeTimer);
    card.classList.add("out");
    card.classList.remove("in");
    setTimeout(() => {
      cleanup();
      next && next();
    }, fast ? 240 : 380);
  };

  // The message types itself out, exactly like the chatbot writing.
  let i = 0;
  typeTimer = setInterval(() => {
    msgEl.textContent = text.slice(0, ++i);
    if (i >= text.length) {
      clearInterval(typeTimer);
      const c = card.querySelector(".type-caret");
      if (c) c.remove();
      timers.push(setTimeout(() => exit(false), 2600 + Math.min(1600, text.length * 8)));
    }
  }, 17);

  __toast = {
    my,
    // Graceful fast-forward: full text NOW, complete quick exit, then next.
    finishFast(next) {
      clearInterval(typeTimer);
      msgEl.textContent = text;
      const c = card.querySelector(".type-caret");
      if (c) c.remove();
      exit(true, next);
    },
  };

  // Clicking the card counts as "read" — it completes and leaves at once.
  card.addEventListener("click", () => {
    if (__toast && __toast.my === my) __toast.finishFast();
  });
}

// Mascot-fronted replacement for window.confirm(). Returns Promise<boolean>.
//   mascotConfirm({ title, message, mood, confirmText, cancelText, danger })
// The mascot sets the emotional stakes: "worried" for risky things, "sad"
// for deletions it will genuinely miss.
function mascotConfirm(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "mconfirm-backdrop";
    wrap.innerHTML =
      '<div class="mconfirm" role="dialog" aria-modal="true">' +
      mascotStage(opts.mood || "worried") +
      "<h3></h3><p></p>" +
      '<div class="mconfirm-actions">' +
      '<button type="button" class="btn ghost" data-act="no"></button>' +
      '<button type="button" class="btn ' +
      (opts.danger ? "danger" : "primary") +
      '" data-act="yes"></button>' +
      "</div></div>";
    wrap.querySelector("h3").textContent = opts.title || "Are you sure?";
    wrap.querySelector("p").textContent = opts.message || "";
    const noBtn = wrap.querySelector('[data-act="no"]');
    const yesBtn = wrap.querySelector('[data-act="yes"]');
    noBtn.textContent = opts.cancelText || "Cancel";
    yesBtn.textContent = opts.confirmText || "Yes, go ahead";
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("show"));
    let settled = false;
    // Once "yes" is clicked the outcome is locked in — the goodbye animation
    // plays, and Escape/backdrop can no longer downgrade it to a cancel.
    let confirming = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      wrap.classList.remove("show");
      setTimeout(() => wrap.remove(), 220);
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === "Escape" && !confirming) done(false);
    };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap && !confirming) done(false);
    });
    noBtn.addEventListener("click", () => {
      if (!confirming) done(false);
    });
    yesBtn.addEventListener("click", () => {
      if (confirming) return;
      if (opts.danger && !settled) {
        confirming = true;
        // The robot takes the news personally: it turns sad and walks off
        // before the dialog closes.
        noBtn.disabled = yesBtn.disabled = true;
        const stage = wrap.querySelector(".mascot-stage");
        if (stage) {
          stage.innerHTML =
            '<span class="mascot-scale bye">' + mascotHTML("sad") + "</span>";
        }
        setTimeout(() => done(true), 800);
      } else {
        done(true);
      }
    });
    // Risky actions start focus on the safe way out.
    (opts.danger ? noBtn : yesBtn).focus();
  });
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

// ---- Roles / auth --------------------------------------------------------
//
// Authentication is entirely server-side: an HttpOnly session cookie, verified
// against the database on every request. NOTHING here is a credential and
// nothing here is trusted — access is enforced by the Worker, on both /api/*
// and the protected HTML pages. The values below only decide which nav links
// to draw.
//
// The old model (localStorage.role = "admin", set by a button with no
// password, plus the raw DEV_KEY in localStorage) is gone. Do not reintroduce
// any auth state in localStorage: it is readable by any script on the origin.

// Mirrors ROLE_RANK in shared/auth-core.mjs. Two groups: the committee, and
// developers who additionally get Ops and Feed AI.
const ROLE_ORDER = { staff: 1, developer: 2 };

// Display-only cache so the nav can render on first paint instead of flashing
// the signed-out menu. sessionStorage, not localStorage, and reconciled
// against the server immediately on every page load.
const USER_HINT_KEY = "bc_user_hint";

let CURRENT_USER = null;

function readUserHint() {
  try {
    const raw = sessionStorage.getItem(USER_HINT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeUserHint(user) {
  try {
    if (user) sessionStorage.setItem(USER_HINT_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(USER_HINT_KEY);
  } catch {
    /* private mode — the nav just re-renders after /api/auth/me */
  }
}

function clearUserHint() {
  CURRENT_USER = null;
  writeUserHint(null);
}

function currentUser() {
  return CURRENT_USER;
}

function isSignedIn() {
  return Boolean(CURRENT_USER);
}

function hasRole(needed) {
  if (!CURRENT_USER) return false;
  return (ROLE_ORDER[CURRENT_USER.role] || 0) >= (ROLE_ORDER[needed] || 0);
}

// Staff = anyone signed in. Kept as a name because several pages read well
// with it, but it is no longer a client-side decision of any consequence.
function isStaff() {
  return isSignedIn();
}

// Ask the server who we are. The only source of truth on the client.
async function refreshUser() {
  try {
    const res = await fetch("/api/auth/me", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    // sessionMethod rides along so the password-setup guard can tell an
    // email-link session (no other way back in) from Google or password ones.
    CURRENT_USER =
      data && data.authenticated
        ? { ...data.user, sessionMethod: data.sessionMethod || "" }
        : null;
    writeUserHint(CURRENT_USER);
  } catch {
    // Network failure: keep whatever we had rather than flapping the nav.
  }
  return CURRENT_USER;
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* log out locally even if the request fails */
  }
  clearUserHint();
  location.href = "/index.html";
}

function goToLogin() {
  location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
}

// Render the shared navigation bar.
//
// The `need` field mirrors the server's PROTECTED_PAGES table in
// shared/auth-core.mjs. Hiding a link is a convenience, not a boundary: the
// Worker refuses the page itself if the role is insufficient.
// The icon only shows in the mobile overlay menu; desktop links stay text.
const NAV_LINKS = [
  { href: "index.html", label: "Home", key: "home", icon: "🏠" },
  { href: "register.html", label: "Register", key: "register", icon: "📝" },
  { href: "reflections.html", label: "Reflections", key: "reflections", need: "developer", icon: "📖" },
  { href: "registrations.html", label: "Registrations", key: "registrations", need: "staff", icon: "🧾" },
  { href: "dashboard.html", label: "Dashboard", key: "dashboard", need: "staff", icon: "📊" },
  { href: "expenses.html", label: "Expenses", key: "expenses", need: "staff", icon: "💸" },
  { href: "ops.html", label: "Ops", key: "ops", need: "developer", icon: "🛠️" },
  { href: "pages.html", label: "Feed AI", key: "pages", need: "developer", icon: "🤖" },
  // account.html is reached through the profile menu in the corner, not a
  // nav link — that's where people look for it.
];

function renderNav(active, opts) {
  // opts.links === false renders the shell only (brand, theme, profile).
  // Used by the forced password-setup screen: offering links the setup guard
  // would instantly bounce back is worse than offering none.
  const bare = opts && opts.links === false;
  const links = bare ? [] : NAV_LINKS.filter((l) => !l.need || hasRole(l.need));
  const user = currentUser();

  // Signed out: a Sign in button among the links. Signed in: the usual
  // corner profile chip — an avatar opening a small menu (account, sign out).
  const authBtn = isSignedIn()
    ? ""
    : `<a class="btn primary small auth-btn" id="authBtn" href="login.html">Sign in</a>`;

  const profile = isSignedIn()
    ? `<div class="nav-profile">
      <button class="avatar-btn" id="profileBtn" type="button" aria-haspopup="menu"
              aria-expanded="false" title="${escapeHtml(user.email)}">${escapeHtml(
        (user.email || "?").charAt(0).toUpperCase()
      )}</button>
      <div class="profile-menu" id="profileMenu" role="menu">
        <div class="profile-head">
          <b class="profile-email">${escapeHtml(user.email)}</b>
          <span class="profile-role">${user.role === "developer" ? "Developer" : "Committee"}</span>
        </div>
        <a class="profile-item" role="menuitem" href="account.html">Your account</a>
        <button class="profile-item" role="menuitem" id="logoutBtn" type="button">Sign out</button>
      </div>
    </div>`
    : "";

  // The same links render twice: as plain text in the bar (desktop) and as
  // circular icons on the frosted overlay (mobile). CSS shows exactly one.
  const linkItems = (withIcons) =>
    links
      .map(
        (l, i) =>
          `<a class="link ${l.key === active ? "active" : ""}"${
            withIcons ? ` style="--i:${i}"` : ""
          } href="${l.href}">${
            withIcons
              ? `<span class="link-ico" aria-hidden="true">${l.icon}</span><span class="link-label">${l.label}</span>`
              : l.label
          }</a>`
      )
      .join("");

  const overlayAuth = isSignedIn()
    ? ""
    : `<a class="link" style="--i:${links.length}" href="login.html"><span class="link-ico" aria-hidden="true">🔑</span><span class="link-label">Sign in</span></a>`;

  return `
  <nav class="nav">
    <span class="brand">
      <button class="logo" id="themeToggle" type="button" title="Tap to switch theme" aria-label="Switch between light and dark theme">
        <svg viewBox="0 0 24 24" width="21" height="21" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="9.2" stroke="rgba(255,255,255,0.9)" stroke-width="1.5"/><polygon points="12,6 17,15.5 7,15.5" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" fill="none"/></svg>
        <span class="theme-hint" aria-hidden="true"></span>
      </button>
      <a class="brand-name" href="index.html"><b>Bangalore Convention</b>
        <small>Unity · Service · Recovery</small>
      </a>
    </span>
    ${profile}${bare ? "" : `
    <button class="nav-toggle" id="navToggle" type="button" title="Menu" aria-label="Menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
    <div class="nav-links" id="navLinks">
      ${linkItems(false)}
      ${authBtn}
    </div>`}
  </nav>${bare ? "" : `
  <div class="nav-overlay" id="navOverlay">
    ${linkItems(true)}
    ${overlayAuth}
  </div>`}`;
}

// Draw the nav and wire its controls. Safe to call twice — refreshUser()
// re-renders once the server has confirmed who we are.
function paintNav(active, opts) {
  document.documentElement.setAttribute("data-role", isSignedIn() ? CURRENT_USER.role : "guest");
  const holder = document.getElementById("nav");
  if (!holder) return;
  holder.innerHTML = renderNav(active, opts);

  const themeBtn = document.getElementById("themeToggle");
  if (themeBtn)
    themeBtn.addEventListener("click", () => {
      toggleTheme();
      themeBtn.classList.remove("theme-flip");
      void themeBtn.offsetWidth; // restart the spin on quick repeat taps
      themeBtn.classList.add("theme-flip");
    });

  // Profile menu: avatar toggles it, any click elsewhere (or Escape) closes
  // it. The document-level closers are replaced on each repaint so they never
  // stack up.
  const profileBtn = document.getElementById("profileBtn");
  const profileMenu = document.getElementById("profileMenu");
  if (profileBtn && profileMenu) {
    profileBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = profileMenu.classList.toggle("open");
      profileBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    profileMenu.addEventListener("click", (e) => e.stopPropagation());
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", logout);
  }
  const closeProfileMenu = () => {
    const m = document.getElementById("profileMenu");
    const b = document.getElementById("profileBtn");
    if (m) m.classList.remove("open");
    if (b) b.setAttribute("aria-expanded", "false");
  };
  if (document.__profileCloser) document.removeEventListener("click", document.__profileCloser);
  document.__profileCloser = closeProfileMenu;
  document.addEventListener("click", document.__profileCloser);
  if (document.__profileEsc) document.removeEventListener("keydown", document.__profileEsc);
  document.__profileEsc = (e) => {
    if (e.key !== "Escape") return;
    closeProfileMenu();
    const ov = document.getElementById("navOverlay");
    const nt = document.getElementById("navToggle");
    if (ov) ov.classList.remove("open");
    if (nt) {
      nt.classList.remove("open");
      nt.setAttribute("aria-expanded", "false");
    }
  };
  document.addEventListener("keydown", document.__profileEsc);

  // Mobile menu = the frosted "corner burst" overlay. The inline .nav-links
  // list is desktop-only now; it no longer opens or closes at all (the old
  // in-flow version grew the sticky nav and shoved the whole page down).
  const navToggle = document.getElementById("navToggle");
  const navOverlay = document.getElementById("navOverlay");
  if (navToggle && navOverlay) {
    // Aim every icon's flight at the hamburger corner. offsetLeft/offsetTop
    // ignore CSS transforms, and the hidden overlay is still laid out
    // (visibility, not display), so this measures the true resting spots.
    const aimAtCorner = () => {
      const cornerX = navOverlay.clientWidth - 38;
      const cornerY = 34; // hamburger centre; the overlay covers the viewport
      navOverlay.querySelectorAll("a").forEach((a) => {
        a.style.setProperty("--fx", cornerX - (a.offsetLeft + a.offsetWidth / 2) + "px");
        a.style.setProperty("--fy", cornerY - (a.offsetTop + a.offsetHeight / 2) + "px");
      });
    };
    const setMenu = (open) => {
      if (open) aimAtCorner();
      navOverlay.classList.toggle("open", open);
      navToggle.classList.toggle("open", open);
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    navToggle.addEventListener("click", () => setMenu(!navOverlay.classList.contains("open")));
    // A tap on the frost itself (not on a link) closes; picking a link also
    // closes so the menu isn't still open when you navigate back.
    navOverlay.addEventListener("click", (e) => {
      if (e.target === navOverlay || e.target.closest("a")) setMenu(false);
    });
  }

  applyTheme(currentTheme());
}

// A session minted from an emailed link belongs to someone with no password
// yet — the email was their only way in. Until they set one, every page
// funnels them to the account page. ("code" is the retired type-a-code flow;
// sessions minted by it may still be alive.)
function needsPasswordSetup(user) {
  return Boolean(
    user && !user.hasPassword && (user.sessionMethod === "magic" || user.sessionMethod === "code")
  );
}

function enforcePasswordSetup(user) {
  if (!needsPasswordSetup(user)) return false;
  // Mirror the server's canonicalPage(): the assets host serves pages
  // EXTENSIONLESS (/account.html 307s to /account), so comparing against
  // "account.html" alone would fail there and redirect in a loop forever.
  let page = (location.pathname.replace(/\/+$/, "").split("/").pop() || "").toLowerCase();
  if (!page) page = "index.html";
  else if (!/\.[a-z0-9]+$/.test(page)) page += ".html";
  if (page === "account.html" || page === "login.html") return false;
  location.replace("account.html?setup=1");
  return true;
}

// ---- Entrance reveals ----------------------------------------------------
// The mobile menu's corner-burst spring is the site's motion language; page
// content shares it: blocks tumble in from the top-right with a small
// rotation, staggered, as they enter the viewport. The classes are applied
// ONLY here — with scripts off they never exist, so nothing stays hidden.
function mountReveals() {
  if (mountReveals.__on) return;
  mountReveals.__on = true;
  if (!("IntersectionObserver" in window)) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  // Hero children and grid cards stagger within their parent; each top-level
  // container block reveals on its own as it scrolls in (no stagger, the
  // scroll position provides the rhythm).
  const GROUPS = [
    { sel: ".hero > *:not(.hero-grid)", stagger: true },
    { sel: ".grid > *", stagger: true },
    { sel: ".reg-layout > *", stagger: true },
    // .mem-wall runs its own per-tile pop (index.html), so it opts out here.
    { sel: ".container > *:not(.grid):not(.reg-layout):not(.mem-wall):not(script):not(style)", stagger: false },
  ];

  // Strip the classes once the entrance ends so the card :hover lifts (and
  // anything else that transitions transform) work again afterwards.
  const finish = (el) => {
    el.classList.remove("rv", "rv-in");
    el.style.removeProperty("--rvi");
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target;
        io.unobserve(el);
        const idx = parseInt(el.style.getPropertyValue("--rvi"), 10) || 0;
        el.classList.add("rv-in");
        // A timeout instead of transitionend: it still fires if the element
        // is display:none'd mid-flight, so nothing gets stuck invisible.
        setTimeout(() => finish(el), 700 + idx * 60);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.05 }
  );

  const scan = () => {
    for (const g of GROUPS) {
      const counts = g.stagger ? new Map() : null;
      document.querySelectorAll(g.sel).forEach((el) => {
        if (el.__rv) return;
        el.__rv = true;
        let idx = 0;
        if (counts) {
          idx = counts.get(el.parentElement) || 0;
          counts.set(el.parentElement, idx + 1);
        }
        el.style.setProperty("--rvi", Math.min(idx, 8));
        el.classList.add("rv");
        io.observe(el);
      });
    }
  };
  scan();

  // Pages draw cards/tables after their API calls — catch those too. One
  // rAF-debounced scan per DOM burst (the per-second countdown rebuild lands
  // here as a no-op: its boxes belong to no group and #countdown stays tagged).
  const mo = new MutationObserver(() => {
    if (mountReveals.__raf) return;
    mountReveals.__raf = requestAnimationFrame(() => {
      mountReveals.__raf = 0;
      scan();
    });
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

// ---- Animated dropdowns --------------------------------------------------
// Native <select> menus can't be animated, so every select (outside the chat
// widget) gets a styled twin that opens with the nav's tumble and staggers
// its rows. The native control STAYS in the DOM holding its name/value —
// FormData, .value reads and existing change listeners all keep working.
function mountDropdowns() {
  if (mountDropdowns.__on) return;
  mountDropdowns.__on = true;

  const closeAllDD = (except) => {
    document.querySelectorAll(".dd.open").forEach((d) => {
      if (d === except) return;
      d.classList.remove("open");
      const b = d.querySelector(".dd-btn");
      if (b) b.setAttribute("aria-expanded", "false");
    });
  };
  document.addEventListener("click", () => closeAllDD(null));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllDD(null);
  });

  function enhance(sel) {
    if (sel.__dd || sel.closest("#chatWidget") || sel.hasAttribute("data-no-dd")) return;
    sel.__dd = true;

    const dd = document.createElement("div");
    dd.className = "dd";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dd-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "dd-menu";
    menu.setAttribute("role", "listbox");
    dd.appendChild(btn);
    dd.appendChild(menu);
    sel.classList.add("dd-native");
    sel.tabIndex = -1;
    sel.insertAdjacentElement("afterend", dd);

    let hi = -1; // keyboard highlight, index into menu rows

    const syncBtn = () => {
      const o = sel.options[sel.selectedIndex];
      btn.innerHTML =
        `<span class="dd-val${o && o.disabled ? " ph" : ""}">${escapeHtml(
          o ? o.textContent : ""
        )}</span><span class="dd-chev" aria-hidden="true">▾</span>`;
    };

    const rebuild = () => {
      menu.innerHTML = "";
      Array.from(sel.options).forEach((o, idx) => {
        if (o.disabled) return; // placeholder rows never appear in the list
        const row = document.createElement("div");
        row.className = "dd-opt" + (idx === sel.selectedIndex ? " sel" : "");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", idx === sel.selectedIndex ? "true" : "false");
        row.style.setProperty("--i", menu.children.length);
        row.textContent = o.textContent;
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          sel.value = o.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          close();
        });
        menu.appendChild(row);
      });
      syncBtn();
    };

    const open = () => {
      closeAllDD(dd);
      rebuild(); // re-sync with whatever the page did to the native select
      dd.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      hi = -1;
    };
    const close = () => {
      dd.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    };

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dd.classList.contains("open")) close();
      else open();
    });

    btn.addEventListener("keydown", (e) => {
      const rows = menu.querySelectorAll(".dd-opt");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!dd.classList.contains("open")) return open();
        if (!rows.length) return;
        hi = e.key === "ArrowDown" ? Math.min(hi + 1, rows.length - 1) : Math.max(hi - 1, 0);
        rows.forEach((r, j) => r.classList.toggle("hi", j === hi));
        rows[hi].scrollIntoView({ block: "nearest" });
      } else if ((e.key === "Enter" || e.key === " ") && dd.classList.contains("open")) {
        e.preventDefault();
        if (hi >= 0 && rows[hi]) rows[hi].click();
        else close();
      } else if (e.key === "Escape") {
        close();
      }
    });

    // The page may rewrite the options (register.html fills categories after
    // its pricing fetch, then preselects from ?category=) — follow along.
    new MutationObserver(() => {
      syncBtn();
      if (dd.classList.contains("open")) rebuild();
    }).observe(sel, { childList: true });
    sel.addEventListener("change", syncBtn);

    rebuild();
  }

  const scan = () => document.querySelectorAll("select").forEach(enhance);
  scan();

  // Catch selects that pages render later, one rAF-debounced scan per burst.
  const mo = new MutationObserver(() => {
    if (mountDropdowns.__raf) return;
    mountDropdowns.__raf = requestAnimationFrame(() => {
      mountDropdowns.__raf = 0;
      scan();
    });
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

// opts.chat === false suppresses the chat widget. The login page passes it:
// a floating mascot that overlaps the password field is not what you want on
// a sign-in screen.
function mountNav(active, opts) {
  const options = opts || {};

  // Paint immediately from the session-scoped hint so the nav does not flash
  // the signed-out menu, then reconcile with the server.
  CURRENT_USER = readUserHint();
  paintNav(active, options);
  if (options.chat !== false) mountChat();
  mountReveals();
  mountDropdowns();

  // Compare against what was just painted. (This used to compare against the
  // hint AFTER refreshUser had overwritten it — fresh against fresh, always
  // equal — so the nav kept showing "Sign in" until the next page load.)
  const painted = JSON.stringify(CURRENT_USER);
  refreshUser().then((user) => {
    if (enforcePasswordSetup(user)) return;
    // Signed out the corner control is #authBtn; signed in it's #profileBtn.
    const hasControl = document.getElementById("authBtn") || document.getElementById("profileBtn");
    if (JSON.stringify(user) !== painted || !hasControl) {
      paintNav(active, options);
    }
    document.dispatchEvent(new CustomEvent("bc:user", { detail: user }));
  });
}

// Pages that need the real role before rendering await this instead of
// racing mountNav's background refresh.
async function requireUser() {
  if (CURRENT_USER) return CURRENT_USER;
  return refreshUser();
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
  ghost.innerHTML = '<span class="fg-icon">💬</span><span class="fg-hand">👋</span>';
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
    // The six mf-* classes that used to be listed here belonged to the
    // commented-out "minute flip" scene and are defined nowhere in the
    // stylesheet, so removing them was pure work on every animation frame.
    fab.classList.remove("waving", "rolling", "jumping", "huge", "demonic", "flying");
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
    // A touch longer than before (was 4.5–7.5s) — calmer, not sleepy.
    return 6500 + Math.random() * 4500;
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

  // (Toast announcements are handled by toast() itself now — it parks the
  // button with .away and holds this scene loop via __mascotSayUntil.)


  // Run the scenes one after another, forever. Pause while the chat is open.
  // minuteFlipBusy is set while the minute-flip overlay scene is running so that
  // chain() doesn't stomp over it.
  // let minuteFlipBusy = false;

  function chain(steps, done) {
    let i = 0;
    (function step() {
      if (i >= steps.length) return done();
      // Mid-announcement (toast): hold the show until the mascot finishes.
      if (window.__mascotSayUntil && Date.now() < window.__mascotSayUntil) {
        return setTimeout(step, 800);
      }
      if (isChatOpen()) {
        clearMoves();
        setForm("box");
        return setTimeout(step, 900);
      }
      const dur = steps[i++]() || 600;
      setTimeout(step, dur);
    })();
  }
  // Every scene stays in the show — grow and the flight included — the
  // rotation is just a touch calmer: one antic fewer, grow and the flight a
  // little less often, one extra rest per cycle.
  function cycle() {
    chain(
      [
        toMascot,
        antic,
        antic,
        () => (Math.random() < 0.35 ? grow() : antic()),
        toBox,
        idleBox,
        toMascot,
        () => (Math.random() < 0.65 ? takeOff() : antic()),
        toBox,
        idleBox,
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

  // Ask the backend to create a Razorpay order. The amount is NOT sent — the
  // server prices the order from the stored registration, so a tampered value
  // here would be ignored anyway.
  let orderData;
  try {
    orderData = await api("/api/payment/create-order", {
      method: "POST",
      body: JSON.stringify({ registrationId: record.id }),
    });
  } catch (err) {
    // Say so. This used to fall through silently to onSuccess(), so a failed
    // order looked exactly like a completed one.
    console.warn("[payment] create-order failed:", err);
    toast("We couldn't start the payment. Your registration is saved — you can pay at the venue.", "error");
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
      } catch (err) {
        // The money left their account but we could not confirm it. Saying
        // nothing here is the worst outcome of all — they would see a plain
        // "Pending" and might pay a second time.
        console.error("[payment] verify failed:", err);
        toast(
          "Payment received, but we couldn't confirm it automatically. Please contact the organisers with your payment id — do not pay again.",
          "error"
        );
      }
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
  } catch (err) {
    console.warn("[payment] checkout failed to open:", err);
    toast("The payment window couldn't open. Your registration is saved — you can pay at the venue.", "error");
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
      <span class="fab-mascot" aria-hidden="true"><span class="fm-rotor"></span>${mascotHTML("")}</span>
    </button>
    <section class="chat-panel" id="chatPanel" aria-live="polite" hidden>
      <div class="chat-fx" aria-hidden="true"><i></i><i></i><i></i><b></b></div>
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

  // Voice mode floats messages over the glow with the history blurred; when
  // the user scrolls back up to read, sharpen everything (.browsing) until
  // they return to the live bottom edge.
  log.addEventListener("scroll", () => {
    const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.classList.toggle("browsing", !pinned);
  });
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
  // One greeting per browser session (not per page load) so the audio we cache
  // below always matches the text we'll actually say, and moving between pages
  // never re-synthesises it.
  const prewarmGreetingText = (() => {
    try {
      const saved = sessionStorage.getItem("greetText");
      if (saved) return saved;
    } catch (e) {}
    const pick = VISITOR_GREETINGS[Math.floor(Math.random() * VISITOR_GREETINGS.length)];
    try {
      sessionStorage.setItem("greetText", pick);
    } catch (e) {}
    return pick;
  })();
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

  // Reveal an assistant reply word by word, each word materialising out of a
  // blur — the "live" feel in both typed chat and talk mode. (This replaced
  // the old per-character typewriter + caret.) Calls done() at the end.
  // Words are added as text nodes inside spans, so no escaping is needed.
  function typeOut(el, txt, msPerChar, done) {
    el.innerHTML = "";
    const spans = [];
    String(txt)
      .split(/(\s+)/)
      .forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) {
          const breaks = part.split("\n").length - 1;
          if (breaks) {
            for (let n = 0; n < breaks; n++) el.appendChild(document.createElement("br"));
          } else {
            el.appendChild(document.createTextNode(" "));
          }
          return;
        }
        const s = document.createElement("span");
        s.className = "lw";
        s.textContent = part;
        el.appendChild(s);
        spans.push(s);
      });
    scrollToMsg(el, "assistant");
    let i = 0;
    (function step() {
      if (i >= spans.length) {
        scrollToMsg(el, "assistant");
        if (done) done();
        return;
      }
      const s = spans[i++];
      s.classList.add("in");
      // Scrolling on every word caused visible jank — every few is plenty.
      if (i % 5 === 1) scrollToMsg(el, "assistant");
      // Same overall pace as the old per-character reveal.
      setTimeout(step, msPerChar * (s.textContent.length + 1));
    })();
  }

  // Streamed twin of typeOut: append only the NEW words of `full` as blur-in
  // spans, so live token streams animate exactly like the greeting. A partial
  // trailing word waits for its next token unless `flush` is set. If the text
  // was rewritten rather than extended, fall back to a plain repaint.
  function appendLive(el, full, flush) {
    const prev = el.__live || "";
    if (!String(full).startsWith(prev)) {
      el.__live = String(full);
      el.innerHTML = escapeHtml(full).replace(/\n/g, "<br>");
      return;
    }
    let delta = String(full).slice(prev.length);
    if (!flush) {
      const cut = Math.max(delta.lastIndexOf(" "), delta.lastIndexOf("\n"));
      if (cut === -1) return;
      delta = delta.slice(0, cut + 1);
    }
    if (!delta) return;
    el.__live = prev + delta;
    let batch = 0;
    delta.split(/(\s+)/).forEach((part) => {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        const breaks = part.split("\n").length - 1;
        if (breaks) {
          for (let n = 0; n < breaks; n++) el.appendChild(document.createElement("br"));
        } else {
          el.appendChild(document.createTextNode(" "));
        }
        return;
      }
      const s = document.createElement("span");
      s.className = "lw";
      s.textContent = part;
      // Words arriving together (a flushed sentence) cascade instead of
      // popping in as one block.
      s.style.transitionDelay = Math.min(batch++ * 28, 560) + "ms";
      el.appendChild(s);
      requestAnimationFrame(() => s.classList.add("in"));
    });
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
      if (hasRole("developer")) {
        greeting = "owner mode! ask me anything — registrations, money, expenses. feed me more knowledge on the Feed AI page and I'll use it instantly.";
      } else if (isSignedIn()) {
        greeting = "hey! got live numbers ready — registrations, payments, pending, expenses. what do you need?";
      } else {
        greeting = prewarmGreetingText; // use the pre-warmed text
      }
      // Speak the greeting and show it as text. Mic stays off — user taps it to start.
      if (!isSignedIn()) {
        if (canListen && !recognition) initRecognition();
        processing = false;
        finalBuffer = "";
        lastInterim = "";
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        typeReply(greeting, true);
        // speak() owns speaking/speakId/afterSpeak. Handing it the pre-warmed
        // first chunk means the voice starts right away instead of after a
        // full round trip to the TTS service.
        speak(greeting, null, prewarmAudioP);
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
  // Every page the assistant can offer to open. `need` mirrors PROTECTED_PAGES
  // on the server — asking to open a page you cannot reach used to silently do
  // nothing, and half the site was missing from this map entirely.
  const PAGES = {
    home: "index.html",
    index: "index.html",
    register: "register.html",
    registration: "register.html",
    pricing: "index.html#pricing",
    privacy: "privacy.html",
    dashboard: "dashboard.html",
    registrations: "registrations.html",
    expenses: "expenses.html",
    account: "account.html",
    reflections: "reflections.html",
    ops: "ops.html",
    feed: "pages.html",
  };

  const NAV_LABELS = {
    home: "Home",
    index: "Home",
    register: "Register",
    registration: "Register",
    pricing: "Pricing",
    privacy: "Privacy",
    dashboard: "Dashboard",
    registrations: "Registrations",
    expenses: "Expenses",
    account: "Account",
    reflections: "Reflections",
    ops: "Ops",
    feed: "Feed AI",
  };

  // Minimum role for the pages that are gated; absent means public.
  const PAGE_NEEDS = {
    dashboard: "staff",
    registrations: "staff",
    expenses: "staff",
    account: "staff",
    reflections: "developer",
    ops: "developer",
    feed: "developer",
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
      // Don't offer a door the visitor can't walk through — the server would
      // just bounce them to the sign-in page.
      const need = PAGE_NEEDS[key];
      if (need && !hasRole(need)) {
        addMsg("assistant", "The " + label + " page is for the organising team — you'd need to sign in first.");
        return;
      }
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
    } else if (action.action === "show_map") {
      showMapCard(action.from, action.to);
    } else if (action.action === "contact_organiser") {
      showContactCard(action.subject || "");
    }
  }

  // AI page publishing (/p/<slug>) was removed deliberately. It stored
  // model-generated HTML and served it from this origin, which meant a
  // published page could read the session's cookies and call the admin API on
  // the viewer's behalf \u2014 a stored XSS shipped on purpose. The knowledge base
  // on the Feed AI page replaces it as the way to teach the assistant.

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
    // Typed mode: the mascot stands beside its words and scribbles while the
    // tokens land, exactly like a non-streamed reply. bubble is its text span.
    let bubble = null, bubbleRow = null, bubbleBot = null;
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
      appendLive(voiceMascot.txt, spokenText, true);
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
        // No role and no key: the server reads the session cookie. The old
        // payload let anyone send role:"admin" and read live financials.
        body: JSON.stringify({
          messages: history,
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
              if (!bubble) {
                const m = addAssistantBubble();
                m.bot.classList.add("writing");
                bubbleRow = m.row;
                bubbleBot = m.bot;
                bubble = m.txt;
              }
              appendLive(bubble, visibleText(fullText));
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

      // Always logged to the console. Shown inline only for owners, so
      // "the assistant is always resting" is never a mystery to whoever can
      // actually fix it. The server only sends `detail` to signed-in staff.
      if (replyDetail) {
        console.error("[chat/voice] server detail:", replyDetail);
        if (hasRole("developer")) addMsg("assistant", "\uD83D\uDEE0\ufe0f debug: " + replyDetail);
      }

      // SSE sent an error event (AI models unavailable) — show friendly message, not "network error".
      if (sseError) {
        if (typingEl.parentNode) typingEl.remove();
        if (voice) { if (voiceMascot) voiceMascot.row.remove(); } else { if (bubbleRow) bubbleRow.remove(); }
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
            // Flush any held-back words; appendLive repaints plainly if the
            // cleaned message differs from what streamed in.
            appendLive(bubble, shown, true);
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
      if (voice) { if (voiceMascot) voiceMascot.row.remove(); } else { if (bubbleRow) bubbleRow.remove(); }
      if (voice) { speaking = false; afterSpeak(); }
      handleAssistantReply(
        "I couldn\u2019t reach the server just now \uD83D\uDCF6. Please check your connection and try again.",
        false
      );
    } finally {
      sendBtn.disabled = false;
      // Stream over -> the mascot puts its pen down.
      if (bubbleBot) bubbleBot.classList.remove("writing");
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

  // Sending a typed message cuts the bot's voice — focusing or typing alone
  // leaves it talking.
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    stopSpeaking();
    const q = text.value.trim();
    if (!q) return;
    if (voiceMode) stopVoiceMode();
    text.value = "";
    sendToChat(q, { voice: false });
  });

  // Touching the text box is an explicit switch to text mode: the mic must not
  // stay live in the background, listening to the room while the user types.
  const leaveVoiceForTyping = () => {
    if (voiceMode) stopVoiceMode();
  };
  text.addEventListener("focus", leaveVoiceForTyping);
  text.addEventListener("input", leaveVoiceForTyping);

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

  // ---- Voice visualizer (Gemini-style reactive bars) -----------------------
  // While the BOT talks the bars follow the real TTS levels via the Web Audio
  // API. While the USER talks they run on CSS keyframes instead: SpeechRecognition
  // owns the microphone, and opening a second getUserMedia capture alongside it
  // makes Chrome's recogniser stop hearing anything at all. Pretty bars are not
  // worth a mic that doesn't listen.
  const vizEl = document.getElementById("voiceViz");
  const vizBars = vizEl ? Array.prototype.slice.call(vizEl.children) : [];
  let vizAC = null, ttsAnalyser = null, ttsSource = null;
  let vizRaf = 0;
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

  // Route a TTS <audio> element through the analyser so the bars move with the
  // bot's actual voice. The analyser passes audio on to the speakers.
  function vizAttachAudio(audioEl) {
    const ctx = vizContext();
    // Only ever route a clip through the graph when the context is already
    // running — a suspended context would swallow the audio completely, and a
    // silent bot is a far worse bug than static bars.
    if (!ctx || ctx.state !== "running") {
      ttsLive = false;
      return;
    }
    try {
      if (!ttsAnalyser) {
        ttsAnalyser = makeAnalyser(ctx);
        ttsAnalyser.connect(ctx.destination);
      }
      try { if (ttsSource) ttsSource.disconnect(); } catch (e) {}
      ttsSource = ctx.createMediaElementSource(audioEl);
      ttsSource.connect(ttsAnalyser);
      ttsLive = true;
    } catch (e) {
      ttsLive = false; // unsupported — the clip still plays normally
    }
  }

  // Five symmetric frequency bands (center = low-mids where voices live) so
  // each bar dances independently, like Gemini's waveform.
  const VIZ_BANDS = [[24, 48], [10, 24], [2, 10], [10, 24], [24, 48]];

  // One 0..1 loudness value drives the "horizon glow" that rises from the
  // panel floor in talk mode. Real analyser levels when available; a soft
  // synthetic pulse when speech plays without one; decays to 0 otherwise.
  let fxAmp = 0;
  function fxSetAmp(target) {
    fxAmp = target > fxAmp ? fxAmp + (target - fxAmp) * 0.45 : fxAmp * 0.86;
    if (panel) panel.style.setProperty("--amp", fxAmp < 0.005 ? "0" : fxAmp.toFixed(3));
  }

  function vizFrame() {
    vizRaf = requestAnimationFrame(vizFrame);
    if (!vizEl) return;
    // Speaking is the only state with a real audio graph; listening/thinking
    // fall through to the CSS keyframe bars.
    const analyser = vizState === "speaking" && ttsLive ? ttsAnalyser : null;
    const live = !!(analyser && vizAC && vizAC.state === "running");
    vizEl.classList.toggle("live", live);
    if (!live) {
      // Browser-voice fallback still speaks without an analyser — keep the
      // glow moving; while listening/thinking the aurora breathes gently so
      // talk mode always visibly glows; outside voice mode it sinks to 0.
      const idle = voiceMode ? 0.12 + Math.sin(performance.now() / 850) * 0.06 : 0;
      fxSetAmp(vizState === "speaking" ? 0.2 + Math.random() * 0.35 : idle);
      return; // CSS keyframes take over the bars for this state
    }
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
    // Real levels average low; lift and floor them so speech reads clearly.
    const mean = vizLevels.reduce((a, b) => a + b, 0) / vizLevels.length;
    fxSetAmp(Math.min(1, 0.12 + mean * 1.1));
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
    fxAmp = 0;
    if (panel) panel.style.setProperty("--amp", "0");
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

  // firstAudioP (optional) is an already-in-flight TTS promise for the FIRST
  // chunk — used by the greeting, which is pre-warmed before the chat opens.
  function speak(msg, onStart, firstAudioP) {
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
    serverSpeak(msg, begin, firstAudioP);
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
    // The OPENING chunk is deliberately small: it decides how long the user
    // stares at silence. Later chunks can be bigger because they're fetched
    // while the previous one is already playing.
    const limitFor = (n) => (n === 0 ? 110 : 220);
    const chunks = [];
    let cur = "";
    let total = 0;
    for (const s of sentences) {
      if (total >= 900) break; // hard cap on how much we ever synthesise
      const piece = s.slice(0, 300);
      if (!cur) cur = piece;
      else if (cur.length + 1 + piece.length <= limitFor(chunks.length)) cur += " " + piece;
      else {
        chunks.push(cur);
        total += cur.length;
        cur = piece;
      }
    }
    if (cur && total < 900) chunks.push(cur);
    return chunks;
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

  // Pre-warm the greeting TTS. Only the FIRST chunk is synthesised here: it is
  // short, so it comes back quickly and playback can start the moment the chat
  // opens while the rest is fetched during that first clip. The result is kept
  // for the whole browser session, so moving between pages costs nothing and
  // opening the chat again is instant.
  const GREET_AUDIO_KEY = "greetAudio";
  function startPrewarm() {
    if (prewarmAudioP || isSignedIn()) return;
    let cached = null;
    try {
      cached = sessionStorage.getItem(GREET_AUDIO_KEY);
    } catch (e) {}
    if (cached) {
      prewarmAudioP = Promise.resolve(cached);
      return;
    }
    prewarmAudioP = fetchTts(splitForSpeech(prewarmGreetingText)[0]).then((audio) => {
      if (audio) {
        try {
          sessionStorage.setItem(GREET_AUDIO_KEY, audio);
        } catch (e) {
          /* quota — we just re-fetch next page */
        }
      }
      return audio;
    });
  }
  fab.addEventListener("pointerenter", startPrewarm, { once: true });
  fab.addEventListener("touchstart", startPrewarm, { once: true, passive: true });
  // Don't make the greeting wait for a hover that may never happen (touch
  // devices never hover): warm it as soon as the page has settled, or on the
  // first interaction anywhere, whichever comes first.
  ["pointerdown", "keydown", "scroll"].forEach((ev) =>
    window.addEventListener(ev, startPrewarm, { once: true, passive: true })
  );
  setTimeout(startPrewarm, 1200);

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

  async function serverSpeak(msg, begin, firstAudioP) {
    const myId = speakId;
    const chunks = splitForSpeech(msg);
    if (!chunks.length) {
      begin && begin();
      afterSpeak();
      return;
    }
    // Prefetch the first chunk (or reuse the pre-warmed one); then loop,
    // prefetching the next while the current one plays so playback is gapless.
    let nextAudio = firstAudioP || fetchTts(chunks[0]);
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
    // Talk mode off (user switched to typing) -> whatever the recogniser was
    // still holding is dropped, never sent. Otherwise a trailing phrase gets
    // committed after the mic was turned off and the bot answers out loud.
    if (!voiceMode) {
      clearInterim();
      return;
    }
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
      // Ignore anything heard while talk mode is off, while the bot is talking,
      // while it's still answering, or in the echo-tail window. This is what
      // stops mobile stacking prompts.
      if (!voiceMode || speaking || processing || Date.now() < ignoreResultsUntil) {
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
        return;
      }
      // Some browsers (Edge especially) reject en-IN outright. Retry once in
      // en-US before giving up \u2014 onend restarts listening with the new lang.
      if (ev.error === "language-not-supported" && recognition.lang !== "en-US") {
        recognition.lang = "en-US";
        return;
      }
      // Anything else fatal used to fail SILENTLY here \u2014 voice mode just sat
      // "listening" forever (classic in Edge, whose recognition service often
      // can't start sessions at all). Say so instead, and bow out cleanly.
      if (
        ev.error === "network" ||
        ev.error === "audio-capture" ||
        ev.error === "language-not-supported"
      ) {
        recognizing = false;
        voiceMode = false;
        stopSpeaking();
        setVoiceStatus("");
        addMsg(
          "assistant",
          "\u26a0\ufe0f Voice recognition couldn't start in this browser (" +
            ev.error +
            "). Google Chrome works best for talk mode \u2014 or check that a microphone is connected."
        );
      }
      // 'no-speech' / 'aborted' fall through; onend restarts listening.
    };

    recognition.onend = () => {
      recognizing = false;
      // Talk mode was switched off — stay stopped and drop the tail. stop()
      // makes the recogniser flush one last result, so this really does happen.
      if (!voiceMode) {
        finalBuffer = "";
        lastInterim = "";
        clearInterim();
        return;
      }
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
    // The greeting (or a previous answer) may still be playing — silence it
    // first, or the mic immediately hears the bot and answers its own voice.
    stopSpeaking();
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

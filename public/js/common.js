// Shared helpers for all pages.

// ---- Theme ----
function currentTheme() {
  return localStorage.getItem("theme") || "midnight";
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

// Render the shared navigation bar.
function renderNav(active) {
  const links = [
    { href: "index.html", label: "Home", key: "home" },
    { href: "register.html", label: "Register", key: "register" },
    { href: "registrations.html", label: "Registrations", key: "registrations" },
    { href: "dashboard.html", label: "Dashboard", key: "dashboard" },
  ];
  return `
  <nav class="nav">
    <a class="brand" href="index.html">
      <span class="logo">AA</span>
      <span>Bangalore Convention
        <small>Unity · Service · Recovery</small>
      </span>
    </a>
    ${links
      .map(
        (l) =>
          `<a class="link ${l.key === active ? "active" : ""}" href="${l.href}">${l.label}</a>`
      )
      .join("")}
    <button class="theme-toggle" id="themeToggle" type="button" title="Switch theme" aria-label="Switch theme">\u2600\uFE0F</button>
  </nav>`;
}

function mountNav(active) {
  const holder = document.getElementById("nav");
  if (holder) holder.innerHTML = renderNav(active);
  const btn = document.getElementById("themeToggle");
  if (btn) btn.addEventListener("click", toggleTheme);
  applyTheme(currentTheme());
}

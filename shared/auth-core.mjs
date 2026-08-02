// Security-critical auth primitives, shared by worker.js (Cloudflare) and
// dev-server.js (Node). Everything here is PURE — no storage, no request
// handling — so the same code runs in both places and cannot drift apart.
//
// Storage-bound logic (D1 queries, KV) lives in worker.js; dev-server.js has
// in-memory equivalents. Only the crypto and the policy tables are shared.

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

export function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(String(str)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison. crypto.subtle.timingSafeEqual is a Cloudflare
// extension; Node has no equivalent on the WebCrypto object, hence the fallback.
export function timingEqual(a, b) {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (x.length !== y.length) return false;
  if (crypto.subtle && typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(x.buffer ? x : new Uint8Array(x), y.buffer ? y : new Uint8Array(y));
  }
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export function timingEqualStr(a, b) {
  return timingEqual(enc.encode(String(a || "")), enc.encode(String(b || "")));
}

async function hmacBytes(keyStr, msgBytes) {
  const km = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(keyStr || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", km, msgBytes));
}

export async function hmacHex(keyStr, msgStr) {
  const out = await hmacBytes(keyStr, enc.encode(String(msgStr)));
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------
//
// Measured in the real Workers runtime (workerd) on 2026-08-02, minimum of 7
// runs per point, PBKDF2-HMAC-SHA256 deriving 256 bits:
//
//     4,000 iter →  1 ms      20,000 iter →   7 ms
//     8,000 iter →  3 ms      30,000 iter →  11 ms
//    12,000 iter →  4 ms      50,000 iter →  20 ms
//    16,000 iter →  5 ms     600,000 iter → 250 ms
//
// Workers does NOT cap iterations at 100k — 600,000 completed fine. The binding
// constraint is the CPU budget: the Free plan allows 10 ms per invocation, so
// 12,000 (~4 ms) leaves room for the D1 lookup and response building. That is
// far below OWASP's recommended 600,000, and the SERVER-SIDE PEPPER below is
// what makes that acceptable:
//
//   peppered = HMAC-SHA256(PASSWORD_PEPPER, password)
//   hash     = PBKDF2(peppered, random salt, iterations)
//
// PASSWORD_PEPPER lives only in Worker secrets and never touches the database.
// An attacker with a full database dump but no pepper cannot mount an offline
// attack AT ANY SPEED, because they do not have the hash input. The iteration
// count only matters if the database and the Worker secrets both leak.
//
// On Workers Paid (30 s CPU) set PBKDF2_ITERATIONS=600000. The iteration count
// is stored in each hash string, so existing passwords keep verifying and are
// transparently upgraded on the owner's next successful login.

export const PBKDF2_DEFAULT_ITERATIONS = 12000;
const PBKDF2_MAX_ITERATIONS = 1000000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

export function pbkdf2Iterations(env) {
  const n = Number((env && env.PBKDF2_ITERATIONS) || PBKDF2_DEFAULT_ITERATIONS);
  if (!Number.isFinite(n) || n < 1000) return PBKDF2_DEFAULT_ITERATIONS;
  return Math.min(Math.floor(n), PBKDF2_MAX_ITERATIONS);
}

// Pepper versions let PASSWORD_PEPPER be rotated without invalidating every
// password: keep the old value as PASSWORD_PEPPER_V1 and verify against the
// version recorded in the hash string.
function pepperFor(env, version) {
  if (version === 1) return (env && (env.PASSWORD_PEPPER || env.PASSWORD_PEPPER_V1)) || "";
  return (env && env["PASSWORD_PEPPER_V" + version]) || "";
}

function currentPepperVersion(env) {
  const v = Number((env && env.PASSWORD_PEPPER_VERSION) || 1);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

async function derive(env, plain, saltBytes, iterations, pepperVersion) {
  const pepper = pepperFor(env, pepperVersion);
  if (!pepper) {
    throw new Error(
      "PASSWORD_PEPPER is not set. Password login is disabled until it is: npx wrangler secret put PASSWORD_PEPPER"
    );
  }
  // NFKC so the same password typed on a different keyboard/IME still verifies.
  const normalized = String(plain).normalize("NFKC");
  const peppered = await hmacBytes(pepper, enc.encode(normalized));
  const km = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    km,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

// Returns a PHC-style, self-describing string:
//   pbkdf2-sha256$v=1$i=12000$p=1$<salt_b64url>$<hash_b64url>
export async function hashPassword(env, plain) {
  const iterations = pbkdf2Iterations(env);
  const pv = currentPepperVersion(env);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(env, plain, salt, iterations, pv);
  return `pbkdf2-sha256$v=1$i=${iterations}$p=${pv}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

export function parsePasswordHash(encoded) {
  const m = /^pbkdf2-sha256\$v=1\$i=(\d+)\$p=(\d+)\$([A-Za-z0-9\-_]+)\$([A-Za-z0-9\-_]+)$/.exec(
    String(encoded || "")
  );
  if (!m) return null;
  return {
    iterations: Number(m[1]),
    pepperVersion: Number(m[2]),
    salt: b64urlDecode(m[3]),
    hash: b64urlDecode(m[4]),
  };
}

// Returns { ok, needsRehash }. Never throws on a malformed stored hash.
export async function verifyPassword(env, plain, encoded) {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return { ok: false, needsRehash: false };
  if (parsed.iterations < 1000 || parsed.iterations > PBKDF2_MAX_ITERATIONS) {
    return { ok: false, needsRehash: false };
  }
  let actual;
  try {
    actual = await derive(env, plain, parsed.salt, parsed.iterations, parsed.pepperVersion);
  } catch {
    return { ok: false, needsRehash: false };
  }
  const ok = timingEqual(actual, parsed.hash);
  const needsRehash =
    ok &&
    (parsed.iterations !== pbkdf2Iterations(env) || parsed.pepperVersion !== currentPepperVersion(env));
  return { ok, needsRehash };
}

// ---------------------------------------------------------------------------
// Password policy — NIST SP 800-63B: length over composition rules
// ---------------------------------------------------------------------------

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

const BANNED_SUBSTRINGS = ["bangalore", "convention", "biaac", "aa2027", "password", "qwerty"];

export function passwordPolicyError(plain, email) {
  const p = String(plain || "");
  if (p.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (p.length > PASSWORD_MAX) return `Keep it under ${PASSWORD_MAX} characters.`;
  const lower = p.toLowerCase();
  for (const bad of BANNED_SUBSTRINGS) {
    if (lower.includes(bad)) return `Too predictable — avoid the word "${bad}".`;
  }
  const local = String(email || "").split("@")[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return "Don't include your email address in your password.";
  if (/^(.)\1+$/.test(p)) return "That's a single repeated character.";
  return null;
}

// Have I Been Pwned k-anonymity check. Only the first 5 characters of the
// SHA-1 leave the Worker, never the password or the full hash.
//
// FAILS OPEN by design: a third party's outage must never stop someone setting
// a password. Called at password-set time only, never on the login path, where
// it would add a subrequest and an availability dependency to the single most
// critical route in the system.
export async function isPwnedPassword(plain, fetchImpl) {
  try {
    const doFetch = fetchImpl || fetch;
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", enc.encode(String(plain))));
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    const prefix = hex.slice(0, 5);
    const suffix = hex.slice(5);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    let res;
    try {
      res = await doFetch("https://api.pwnedpasswords.com/range/" + prefix, {
        headers: { "Add-Padding": "true" },
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return false;
    const text = await res.text();
    for (const line of text.split("\n")) {
      const [suf, count] = line.trim().split(":");
      if (suf === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch {
    return false; // fail open
  }
}

// ---------------------------------------------------------------------------
// Identity + roles
// ---------------------------------------------------------------------------

export function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}

export function isValidEmail(raw) {
  const e = normalizeEmail(raw);
  return e.length >= 6 && e.length <= 254 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(e);
}

// Two groups, and only two.
//
//   staff     — the organising committee. Registrations, dashboard, expenses,
//               reflections. Everything they need to run the event.
//   developer — the same, plus Ops (email digests, Deepgram/Cloudflare
//               figures) and Feed AI (the knowledge base injected into every
//               chat system prompt). Both are technical surfaces.
//
// Who is in which group is decided by config, not by a database row or an
// invite flow — see resolveRoleFromConfig() in worker.js.
export const ROLE_RANK = { staff: 1, developer: 2 };
export const ROLES = Object.keys(ROLE_RANK);

export function roleAtLeast(role, needed) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[needed] || 0);
}

// Parses a comma-separated allowlist from config into normalised emails.
export function parseEmailList(raw) {
  return String(raw || "")
    .split(",")
    .map((e) => normalizeEmail(e))
    .filter((e) => e.length > 0);
}

// ---------------------------------------------------------------------------
// Page policy
// ---------------------------------------------------------------------------
//
// Minimum role required to load each HTML page. Anything not listed here is
// public. `pages.html` is the AI knowledge-base editor (its content is injected
// into every chat system prompt), so it sits at owner.

export const PROTECTED_PAGES = {
  "/registrations.html": "staff",
  "/dashboard.html": "staff",
  "/expenses.html": "staff",
  "/account.html": "staff",
  // Developer surfaces. Ops runs the email digests and exposes billing
  // figures; Feed AI writes straight into the assistant's system prompt; and
  // Reflections can fire a PAID WhatsApp broadcast, one message per recipient.
  "/reflections.html": "developer",
  "/ops.html": "developer",
  "/pages.html": "developer",
};

export const PUBLIC_PAGES = [
  "/index.html",
  "/register.html",
  "/privacy.html",
  "/login.html",
  "/403.html",
];

export const PAGE_ALLOWLIST = new Set([...PUBLIC_PAGES, ...Object.keys(PROTECTED_PAGES)]);

// The Cloudflare [assets] binding defaults to html_handling = auto-trailing-slash,
// so /dashboard, /dashboard/ and /dashboard.html all serve the same file.
// Matching a literal ".html" path would therefore be trivially bypassed by
// requesting the extensionless form. Everything is canonicalised first.
export function canonicalPage(pathname) {
  let p;
  try {
    p = decodeURIComponent(String(pathname || "/"));
  } catch {
    return null; // malformed percent-encoding
  }
  if (p.includes("\\") || p.includes("..") || p.includes("\0")) return null;
  p = p.toLowerCase().replace(/\/+$/, "");
  if (p === "" || p === "/") return "/index.html";
  if (!p.startsWith("/")) return null;
  if (!/\.[a-z0-9]+$/.test(p)) p += ".html";
  return p;
}

// Validates a post-login redirect target. Returns a safe same-origin page path,
// never an absolute URL. Applied on BOTH write and read, because the value
// round-trips through a URL the user can edit.
export function safeNext(raw, fallback = "/index.html") {
  const v = String(raw || "");
  if (!v || !v.startsWith("/")) return fallback;
  if (v.startsWith("//") || v.startsWith("/\\")) return fallback; // protocol-relative
  if (/[\r\n\t\0]/.test(v)) return fallback; // header injection
  if (v.startsWith("/api/")) return fallback; // don't bounce into the API
  let u;
  try {
    u = new URL(v, "https://placeholder.invalid");
  } catch {
    return fallback;
  }
  const p = canonicalPage(u.pathname);
  if (!p || !PAGE_ALLOWLIST.has(p)) return fallback;
  return p + (u.search || "");
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------
//
// The __Host- prefix is the strongest cookie form available: browsers reject it
// unless it has Secure, Path=/ and NO Domain attribute, which makes it host-only
// and impossible for a subdomain to set or overwrite.
//
// It REQUIRES Secure, which browsers refuse over plain http://localhost — hence
// the conditional naming. Getting this wrong produces a login that silently
// never persists, so it is centralised here rather than inlined at call sites.

export function isInsecureOrigin(env) {
  const origin = (env && env.AUTH_ORIGIN) || "";
  return origin.startsWith("http://") || String((env && env.AUTH_INSECURE_COOKIES) || "") === "1";
}

export function cookieName(env, base) {
  return isInsecureOrigin(env) ? "bc_" + base : "__Host-bc_" + base;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function buildCookie(env, base, value, { maxAge, httpOnly = true } = {}) {
  const parts = [`${cookieName(env, base)}=${value}`, "Path=/", "SameSite=Lax"];
  if (!isInsecureOrigin(env)) parts.push("Secure");
  if (httpOnly) parts.push("HttpOnly");
  // Max-Age=0 must still be emitted (it is how a cookie is cleared).
  if (typeof maxAge === "number") parts.push("Max-Age=" + Math.max(0, Math.floor(maxAge)));
  return parts.join("; ");
}

export function clearCookie(env, base) {
  return buildCookie(env, base, "", { maxAge: 0 });
}

// ---------------------------------------------------------------------------
// Session + CSRF policy constants
// ---------------------------------------------------------------------------

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000; // 12h — an ops shift
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // 7d, never extended
export const SESSION_TOUCH_MS = 5 * 60 * 1000; // throttle last_seen writes
export const SUDO_MS = 15 * 60 * 1000; // step-up window for owner actions
export const MAGIC_TTL_MS = 15 * 60 * 1000;
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export const OAUTH_TTL_MS = 10 * 60 * 1000;
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_BASE_MS = 15 * 60 * 1000;
export const LOCKOUT_MAX_MS = 24 * 60 * 60 * 1000;

// Cross-site POST is already blocked by SameSite=Lax, but Lax does not cover
// every browser and does not cover top-level GET. Origin is the primary gate.
// Browsers always send Origin on non-GET fetches, same-origin included, so
// rejecting when BOTH Origin and Referer are absent is the correct fail-closed
// default — the only clients that breaks are non-browsers.
export function checkOrigin(request, env) {
  const m = request.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return true;

  let allowed;
  try {
    allowed = new URL(env.AUTH_ORIGIN).origin;
  } catch {
    try {
      allowed = new URL(request.url).origin;
    } catch {
      return false;
    }
  }

  const origin = request.headers.get("Origin");
  if (origin) return origin === allowed;

  const ref = request.headers.get("Referer");
  if (ref) {
    try {
      return new URL(ref).origin === allowed;
    } catch {
      return false;
    }
  }
  return false;
}

// HTML forms can only send urlencoded, multipart or text/plain, so requiring
// JSON makes form-based CSRF impossible without a preflight — and a preflight
// needs CORS, which is never granted.
export function checkJsonContentType(request) {
  const m = request.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS" || m === "DELETE") return true;
  const ct = String(request.headers.get("content-type") || "").toLowerCase();
  return ct.includes("application/json");
}

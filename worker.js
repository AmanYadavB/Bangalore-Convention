// Cloudflare Worker - serves the static site (public/) AND the /api/* backend.
// Storage: one KV namespace bound as CONVENTION_KV (configured in wrangler.toml).
// Static files are served through the ASSETS binding (also in wrangler.toml).

// Prices live in one place and are shared with dev-server.js. The chat system
// prompt's price line is generated from the same array so a price change can
// never leave the bot quoting stale numbers.
import { PRICING, findCategory, pricingPhrase } from "./shared/pricing.mjs";
import { factsPromptBlock, groundingRuleBlock, STYLE_REMINDER } from "./shared/facts.mjs";
import {
  b64urlEncode,
  randomToken,
  sha256Hex,
  hmacHex,
  timingEqual,
  timingEqualStr,
  hashPassword,
  verifyPassword,
  passwordPolicyError,
  isPwnedPassword,
  normalizeEmail,
  isValidEmail,
  parseEmailList,
  ROLE_RANK,
  ROLES,
  roleAtLeast,
  PROTECTED_PAGES,
  PAGE_ALLOWLIST,
  canonicalPage,
  safeNext,
  cookieName,
  parseCookies,
  buildCookie,
  clearCookie,
  SESSION_IDLE_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_TOUCH_MS,
  MAGIC_TTL_MS,
  OAUTH_TTL_MS,
  LOCKOUT_THRESHOLD,
  LOCKOUT_BASE_MS,
  LOCKOUT_MAX_MS,
  checkOrigin,
  checkJsonContentType,
} from "./shared/auth-core.mjs";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function loadList(env, key) {
  const data = await env.CONVENTION_KV.get(key, { type: "json" });
  return Array.isArray(data) ? data : [];
}

async function saveList(env, key, list) {
  await env.CONVENTION_KV.put(key, JSON.stringify(list));
}

// ---- Usage tracking (feeds the daily dashboard email) ----------------------
// One KV JSON blob per day: counters for chat/TTS/provider wins. Kept 45 days.
// Days are bucketed by IST date so "today" in the email matches the organiser's
// day, not UTC's (which flips at 5:30 AM IST).
const istDate = (daysAgo) =>
  new Date(Date.now() + 5.5 * 3600 * 1000 - (daysAgo || 0) * 86400000)
    .toISOString()
    .slice(0, 10);
const usageKey = (d) => "usage:" + (d || istDate(0));

async function bumpUsage(env, updates) {
  try {
    const key = usageKey();
    const cur = (await env.CONVENTION_KV.get(key, { type: "json" })) || {};
    for (const [k, v] of Object.entries(updates)) {
      if (k === "models") {
        cur.models = cur.models || {};
        for (const [m, n] of Object.entries(v)) cur.models[m] = (cur.models[m] || 0) + n;
      } else {
        cur[k] = (cur[k] || 0) + v;
      }
    }
    await env.CONVENTION_KV.put(key, JSON.stringify(cur), { expirationTtl: 60 * 60 * 24 * 45 });
  } catch (e) {
    /* tracking must never break the app */
  }
}

// Fire-and-forget: never adds latency to the user's request.
function track(env, ctx, updates) {
  const p = bumpUsage(env, updates);
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

// Groq has no usage/billing API, but every API response carries rate-limit
// headers: requests remaining TODAY and tokens remaining this minute. Keep the
// latest snapshot in KV so the dashboard shows real remaining Groq quota.
function captureGroqLimits(env, ctx, res) {
  try {
    const num = (v) => {
      if (v === null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const snap = {
      at: new Date().toISOString(),
      requestsLimit: num(res.headers.get("x-ratelimit-limit-requests")),
      requestsRemaining: num(res.headers.get("x-ratelimit-remaining-requests")),
      tokensLimit: num(res.headers.get("x-ratelimit-limit-tokens")),
      tokensRemaining: num(res.headers.get("x-ratelimit-remaining-tokens")),
    };
    if (snap.requestsLimit === null && snap.tokensLimit === null) return;
    const p = env.CONVENTION_KV.put("groq:limits", JSON.stringify(snap), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  } catch (e) {
    /* never break a reply over telemetry */
  }
}

// ---- Developer-generated pages (stored in D1) ----------------------------
// Both tables only need creating once per isolate; skipping the repeat DDL
// saves a D1 round trip on every chat message and /p/<slug> view.
let pagesTableReady = false;
async function ensurePagesTable(env) {
  if (pagesTableReady) return;
  await env.CONVENTION_DB.exec(
    "CREATE TABLE IF NOT EXISTS pages (slug TEXT PRIMARY KEY, title TEXT NOT NULL, html TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
  );
  pagesTableReady = true;
}

// ---- Developer-fed knowledge for the AI (stored in D1) -------------------
// Content is capped so one huge paste cannot crowd out the rest of the chat
// system prompt. The cap is reported back to the client rather than silently
// truncating.
const KNOWLEDGE_MAX_CHARS = 20000;
let knowledgeTableReady = false;
async function ensureKnowledgeTable(env) {
  if (knowledgeTableReady) return;
  await env.CONVENTION_DB.exec(
    "CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)"
  );
  knowledgeTableReady = true;
}

// Compact, length-bounded blob of the fed knowledge that is MOST RELEVANT to
// the user's question. This is injected into the chat system prompt so the bot
// answers from it. When lots of data is fed (e.g. a long doctor's note), we
// score entries/passages against the question so big notes can't crowd out the
// small note the user is actually asking about.
const STOP_WORDS = new Set([
  "the","and","for","are","but","not","you","your","our","with","this","that",
  "have","has","was","were","what","when","where","which","who","whom","how",
  "why","can","could","would","should","about","from","into","over","under",
  "there","here","then","than","them","they","their","some","any","all","also",
  "will","shall","may","might","much","many","more","most","tell","give","get",
  "know","does","did","done","being","been","a","an","of","to","in","on","is",
  "it","as","at","or","if","so","do","me","my","we","us","i",
]);

function tokenizeQuery(q) {
  const set = new Set();
  String(q || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .forEach((w) => {
      if (w.length >= 3 && !STOP_WORDS.has(w)) set.add(w);
    });
  return set;
}

// How many query words appear in this text (title weighted a little heavier).
function scoreText(text, qWords, weight) {
  if (!qWords.size) return 0;
  const lower = String(text || "").toLowerCase();
  let score = 0;
  for (const w of qWords) {
    if (lower.indexOf(w) !== -1) score += weight || 1;
  }
  return score;
}

// From a long note, pull the paragraphs most relevant to the question, keeping
// their order, up to maxLen characters. Falls back to the start of the note.
function relevantSlice(content, qWords, maxLen) {
  const text = String(content || "");
  if (text.length <= maxLen) return text;
  const paras = text
    .split(/\n\s*\n|\r\n\r\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length <= 1) return text.slice(0, maxLen);
  const ranked = paras
    .map((p, i) => ({ p, i, s: scoreText(p, qWords, 1) }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const picked = [];
  let used = 0;
  for (const r of ranked) {
    if (r.s <= 0 && picked.length) continue; // once we have hits, skip misses
    if (used + r.p.length > maxLen) {
      if (!picked.length) picked.push({ i: r.i, p: r.p.slice(0, maxLen) });
      break;
    }
    picked.push({ i: r.i, p: r.p });
    used += r.p.length + 2;
    if (used >= maxLen) break;
  }
  picked.sort((a, b) => a.i - b.i); // restore reading order
  return picked.map((x) => x.p).join("\n\n");
}

async function buildKnowledge(env, query) {
  if (!env.CONVENTION_DB) return "";
  try {
    await ensureKnowledgeTable(env);
    const { results } = await env.CONVENTION_DB.prepare(
      "SELECT title, content FROM knowledge ORDER BY created_at ASC LIMIT 100"
    ).all();
    if (!results || !results.length) return "";

    const budget = 3500; // keep the prompt lean so big notes never overflow
    const qWords = tokenizeQuery(query);

    // Score every entry against the question (title counts double).
    const scored = results.map((r) => ({
      title: r.title || "",
      content: r.content || "",
      score:
        scoreText(r.title, qWords, 2) + scoreText(r.content, qWords, 1),
    }));

    const relevant = scored
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score);

    const out = [];
    let left = budget;

    // Prefer the relevant entries; pull their most on-topic passages first so a
    // single huge note can't swallow the whole budget (cap ~1600 chars each).
    const chosen = relevant.length ? relevant : scored.slice(-8); // fallback: recent
    for (const e of chosen) {
      if (left <= 200) break;
      const slice = relevantSlice(e.content, qWords, Math.min(1600, left));
      const chunk = (e.title ? e.title + ": " : "") + slice;
      if (chunk.length > left) {
        out.push(chunk.slice(0, left));
        break;
      }
      out.push(chunk);
      left -= chunk.length + 2;
    }
    return out.join("\n\n");
  } catch (e) {
    return "";
  }
}

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

// ===========================================================================
// AUTH — sessions, staff accounts, rate limiting, audit log
// ===========================================================================
//
// Storage-bound half of the auth system. The pure crypto and policy tables live
// in shared/auth-core.mjs so dev-server.js runs the exact same code.
//
// ALL auth state is in D1, not KV, for two reasons:
//   1. KV is eventually consistent (~60s), so a revoked session would stay
//      valid at other edges for up to a minute, and a single-use magic token
//      could be redeemed twice. D1 is strongly consistent.
//   2. The KV free tier allows 1,000 writes/day, which sessions and rate-limit
//      counters would exhaust. D1's free tier is 100k writes/day.

let authTablesReady = false;
const AUTH_DDL = [
  `CREATE TABLE IF NOT EXISTS staff (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL DEFAULT '',
     role TEXT NOT NULL DEFAULT 'staff',
     status TEXT NOT NULL DEFAULT 'invited',
     password_hash TEXT,
     google_sub TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_login_at INTEGER,
     pwd_changed_at INTEGER,
     failed_count INTEGER NOT NULL DEFAULT 0,
     locked_until INTEGER NOT NULL DEFAULT 0
   )`,
  // SQLite allows many NULLs in a UNIQUE index, so staff without a linked
  // Google account do not collide with each other.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_google ON staff(google_sub)`,
  `CREATE TABLE IF NOT EXISTS session (
     id TEXT PRIMARY KEY,
     staff_id TEXT NOT NULL,
     csrf TEXT NOT NULL,
     method TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     absolute_exp INTEGER NOT NULL,
     sudo_until INTEGER NOT NULL DEFAULT 0,
     revoked_at INTEGER,
     ip TEXT NOT NULL DEFAULT '',
     ua TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_session_staff ON session(staff_id, revoked_at)`,
  `CREATE TABLE IF NOT EXISTS staff_invite (
     token_hash TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     role TEXT NOT NULL,
     invited_by TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER
   )`,
  // Magic-link and OAuth state live in D1 rather than KV so single-use can be
  // enforced with a conditional UPDATE (changes === 1), which KV cannot do.
  `CREATE TABLE IF NOT EXISTS magic_token (
     token_hash TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     purpose TEXT NOT NULL DEFAULT 'login',
     next TEXT NOT NULL DEFAULT '',
     csrf TEXT NOT NULL,
     bind_id TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER,
     approved_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS oauth_tx (
     state TEXT PRIMARY KEY,
     verifier TEXT NOT NULL,
     nonce TEXT NOT NULL,
     next TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS auth_event (
     id TEXT PRIMARY KEY,
     at INTEGER NOT NULL,
     type TEXT NOT NULL,
     staff_id TEXT,
     email TEXT,
     ip TEXT,
     ua TEXT,
     country TEXT,
     outcome TEXT NOT NULL DEFAULT 'ok',
     detail TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_event_at ON auth_event(at)`,
  `CREATE TABLE IF NOT EXISTS rate_limit (
     k TEXT PRIMARY KEY,
     n INTEGER NOT NULL,
     reset_at INTEGER NOT NULL
   )`,
];

// Columns added after the tables first shipped. CREATE TABLE IF NOT EXISTS
// will not add them to an existing database, so they are applied separately
// and the "duplicate column" error is the expected no-op on later boots.
const AUTH_MIGRATIONS = [
  // code_hash/attempts are leftovers from the retired type-a-code flow; they
  // stay in old databases but nothing reads or writes them anymore.
  "ALTER TABLE magic_token ADD COLUMN approved_at INTEGER",
];

async function ensureAuthTables(env) {
  if (authTablesReady) return;
  if (!env.CONVENTION_DB) throw new Error("D1 binding CONVENTION_DB is required for authentication.");
  await env.CONVENTION_DB.batch(AUTH_DDL.map((sql) => env.CONVENTION_DB.prepare(sql)));
  for (const sql of AUTH_MIGRATIONS) {
    try {
      await env.CONVENTION_DB.prepare(sql).run();
    } catch (e) {
      if (!/duplicate column/i.test(String(e && e.message))) {
        console.log("auth migration failed:", sql, e && e.message);
      }
    }
  }
  authTablesReady = true;
}

const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "";
const clientUa = (request) => String(request.headers.get("User-Agent") || "").slice(0, 200);

// ---- Audit log ------------------------------------------------------------
// Fire-and-forget, mirroring track(): auditing must never add latency and must
// never break a request.
//
// PII discipline: for failures on emails that are NOT known staff, the address
// is hashed. Otherwise anyone could write arbitrary strings into the database
// by failing logins, turning the audit log into a PII sink.
async function writeAuthEvent(env, ev) {
  await ensureAuthTables(env);
  await env.CONVENTION_DB.prepare(
    `INSERT INTO auth_event (id, at, type, staff_id, email, ip, ua, country, outcome, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      Date.now(),
      String(ev.type || "unknown"),
      ev.staffId || null,
      ev.email || null,
      ev.ip || null,
      ev.ua || null,
      ev.country || null,
      String(ev.outcome || "ok"),
      ev.detail ? String(ev.detail).slice(0, 500) : null
    )
    .run();
}

function audit(env, ctx, ev) {
  const p = writeAuthEvent(env, ev).catch((e) => console.log("audit failed:", e && e.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return p;
}

function auditFrom(request, ev) {
  return {
    ip: clientIp(request),
    ua: clientUa(request),
    country: (request.cf && request.cf.country) || null,
    ...ev,
  };
}

// ---- Rate limiting --------------------------------------------------------
// Fixed window in D1. Strongly consistent, so a distributed attacker cannot
// undercount by spreading across edges the way they could with KV.
async function rateLimit(env, scope, id, limit, windowSec) {
  try {
    await ensureAuthTables(env);
    const now = Date.now();
    const bucket = Math.floor(now / 1000 / windowSec);
    const k = `${scope}:${id}:${bucket}`;
    const resetAt = (bucket + 1) * windowSec * 1000;

    const row = await env.CONVENTION_DB.prepare("SELECT n FROM rate_limit WHERE k = ?").bind(k).first();
    const n = row ? Number(row.n) : 0;
    if (n >= limit) {
      return { allowed: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
    }
    await env.CONVENTION_DB.prepare(
      `INSERT INTO rate_limit (k, n, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(k) DO UPDATE SET n = n + 1`
    )
      .bind(k, resetAt)
      .run();
    return { allowed: true, remaining: limit - n - 1, retryAfter: 0 };
  } catch (e) {
    // A rate-limiter outage must not take the site down. Fail open, but shout.
    console.log("rateLimit failed:", e && e.message);
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }
}

function tooManyRequests(retryAfter) {
  return new Response(JSON.stringify({ error: "Too many requests. Please wait and try again." }), {
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(retryAfter || 60),
    },
  });
}

// ---- Staff accounts -------------------------------------------------------

async function staffByEmail(env, email) {
  await ensureAuthTables(env);
  return env.CONVENTION_DB.prepare("SELECT * FROM staff WHERE email = ?")
    .bind(normalizeEmail(email))
    .first();
}

async function staffById(env, id) {
  await ensureAuthTables(env);
  return env.CONVENTION_DB.prepare("SELECT * FROM staff WHERE id = ?").bind(id).first();
}

async function staffCount(env) {
  await ensureAuthTables(env);
  const row = await env.CONVENTION_DB.prepare("SELECT COUNT(*) AS n FROM staff").first();
  return Number((row && row.n) || 0);
}

async function createStaff(env, { email, name, role, status }) {
  await ensureAuthTables(env);
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.CONVENTION_DB.prepare(
    `INSERT INTO staff (id, email, name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, normalizeEmail(email), String(name || ""), role, status, now, now)
    .run();
  return staffById(env, id);
}

// Who is allowed in, and as what — decided entirely by config.
//
// There is no invite flow and no staff-management UI: for a committee of a
// handful of people, two lists in wrangler.toml are easier to reason about and
// impossible to get subtly wrong. Adding someone means adding their email and
// redeploying; removing someone means deleting it, and they lose access on
// their next request because the role is re-derived on every session read.
//
// Returns "developer", "staff", or null (not allowed in at all).
function resolveRoleFromConfig(env, email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  if (parseEmailList(env.DEVELOPER_EMAILS).includes(e)) return "developer";
  if (parseEmailList(env.STAFF_EMAILS).includes(e)) return "staff";
  return null;
}

// Find or create the local record for an allowlisted email. The row exists to
// hold a password hash, lockout counters and session links — it is NOT the
// authority on whether someone may sign in, or on what they can do.
async function staffForEmail(env, ctx, email, request) {
  const role = resolveRoleFromConfig(env, email);
  if (!role) return null;

  let row = await staffByEmail(env, email);
  if (!row) {
    row = await createStaff(env, { email, name: "", role, status: "active" });
    audit(env, ctx, auditFrom(request, { type: "staff_created", staffId: row.id, email: row.email, detail: role }));
  } else if (row.role !== role || row.status !== "active") {
    // Config is the source of truth, so a change there takes effect here.
    await env.CONVENTION_DB.prepare(
      "UPDATE staff SET role = ?, status = 'active', updated_at = ? WHERE id = ?"
    )
      .bind(role, Date.now(), row.id)
      .run();
    row = await staffById(env, row.id);
  }
  return row;
}

// Account lockout lives in D1 rather than a KV counter because it is
// correctness-critical: an undercount lets a brute-force through.
async function registerLoginFailure(env, staff) {
  const failed = Number(staff.failed_count || 0) + 1;
  let lockedUntil = Number(staff.locked_until || 0);
  if (failed >= LOCKOUT_THRESHOLD) {
    // Doubles each time the threshold is crossed again, capped at 24h.
    const overshoot = failed - LOCKOUT_THRESHOLD;
    const span = Math.min(LOCKOUT_BASE_MS * Math.pow(2, overshoot), LOCKOUT_MAX_MS);
    lockedUntil = Date.now() + span;
  }
  await env.CONVENTION_DB.prepare(
    "UPDATE staff SET failed_count = ?, locked_until = ?, updated_at = ? WHERE id = ?"
  )
    .bind(failed, lockedUntil, Date.now(), staff.id)
    .run();
  return lockedUntil;
}

async function clearLoginFailures(env, staffId) {
  await env.CONVENTION_DB.prepare(
    "UPDATE staff SET failed_count = 0, locked_until = 0, last_login_at = ?, updated_at = ? WHERE id = ?"
  )
    .bind(Date.now(), Date.now(), staffId)
    .run();
}

// ---- Sessions -------------------------------------------------------------
//
// Opaque random token, server-side record. Not a JWT: revocation must be
// instant (role changes and disables are privileged operations), session
// listing must be possible, and a missed session lookup fails CLOSED whereas a
// missed denylist check on a JWT fails OPEN.
//
// The STORED id is sha256(token) — a database dump or a leaked log line can
// never be replayed as a live session.

// Optional cheap pre-filter so well-formed garbage cannot force a D1 read.
// Degrades safely: with no SESSION_PEPPER set, the D1 lookup is still the real
// boundary, so a missing secret costs a little DB load, not security.
async function sessionTag(env, sid) {
  if (!env.SESSION_PEPPER) return "";
  return (await hmacHex(env.SESSION_PEPPER, sid)).slice(0, 32);
}

async function createSession(env, staff, method, request) {
  await ensureAuthTables(env);
  const sid = randomToken(32);
  const id = await sha256Hex(sid);
  const csrf = randomToken(24);
  const now = Date.now();
  await env.CONVENTION_DB.prepare(
    `INSERT INTO session (id, staff_id, csrf, method, created_at, last_seen_at, absolute_exp, ip, ua)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, staff.id, csrf, String(method || ""), now, now, now + SESSION_ABSOLUTE_MS, clientIp(request), clientUa(request))
    .run();

  const tag = await sessionTag(env, sid);
  return { sid, id, csrf, cookieValue: tag ? `${sid}.${tag}` : sid, absoluteExp: now + SESSION_ABSOLUTE_MS };
}

// Returns { session, staff } or null. Never throws.
async function readSession(request, env) {
  try {
    const cookies = parseCookies(request.headers.get("Cookie"));
    const raw = cookies[cookieName(env, "session")];
    if (!raw) return null;

    const [sid, tag] = String(raw).split(".");
    if (!sid || !/^[A-Za-z0-9\-_]{20,64}$/.test(sid)) return null;
    if (env.SESSION_PEPPER) {
      const expected = await sessionTag(env, sid);
      if (!tag || !timingEqualStr(tag, expected)) return null;
    }

    await ensureAuthTables(env);
    const id = await sha256Hex(sid);
    const row = await env.CONVENTION_DB.prepare("SELECT * FROM session WHERE id = ?").bind(id).first();
    if (!row) return null;

    const now = Date.now();
    if (row.revoked_at) return null;
    if (now > Number(row.absolute_exp)) return null;
    if (now - Number(row.last_seen_at) > SESSION_IDLE_MS) return null;

    const staff = await staffById(env, row.staff_id);
    if (!staff || staff.status !== "active") return null;

    // Re-derive the role from config on every request rather than trusting the
    // stored row. Removing someone from the allowlist then takes effect on
    // their very next request instead of whenever their session happens to
    // expire, and there is no stale-privilege window after a config change.
    const configRole = resolveRoleFromConfig(env, staff.email);
    if (!configRole) return null;
    staff.role = configRole;

    // Throttled so a busy session does not mean a D1 write per request.
    if (now - Number(row.last_seen_at) > SESSION_TOUCH_MS) {
      await env.CONVENTION_DB.prepare("UPDATE session SET last_seen_at = ? WHERE id = ?")
        .bind(now, id)
        .run();
    }
    return { session: row, staff };
  } catch (e) {
    console.log("readSession failed:", e && e.message);
    return null;
  }
}

async function revokeSession(env, id) {
  await env.CONVENTION_DB.prepare("UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(Date.now(), id)
    .run();
}

// Revoking every session for a user is part of disabling them and part of any
// role change. A disable that leaves live sessions is not a disable.
async function revokeAllSessions(env, staffId, exceptId) {
  const sql = exceptId
    ? "UPDATE session SET revoked_at = ? WHERE staff_id = ? AND revoked_at IS NULL AND id != ?"
    : "UPDATE session SET revoked_at = ? WHERE staff_id = ? AND revoked_at IS NULL";
  const stmt = env.CONVENTION_DB.prepare(sql);
  await (exceptId ? stmt.bind(Date.now(), staffId, exceptId) : stmt.bind(Date.now(), staffId)).run();
}

// New session + old one revoked in a single batch, so there is never a window
// where both or neither is valid. Called on every login (session fixation),
// role change, and password change.
async function rotateSession(env, oldId, staff, method, request) {
  const created = await createSession(env, staff, method, request);
  if (oldId) await revokeSession(env, oldId);
  return created;
}

function sessionCookieHeaders(env, created) {
  const maxAge = Math.floor((created.absoluteExp - Date.now()) / 1000);
  return [
    buildCookie(env, "session", created.cookieValue, { maxAge, httpOnly: true }),
    // Deliberately NOT HttpOnly: client JS must read it to echo it in a header.
    buildCookie(env, "csrf", created.csrf, { maxAge, httpOnly: false }),
  ];
}

// The CSRF header is compared against the SESSION ROW, not against the cookie.
// Plain cookie-vs-header double-submit can be satisfied by an attacker who can
// set cookies; comparing against server-side state cannot be forged.
function checkCsrf(request, sessionRow) {
  const sent = request.headers.get("X-CSRF-Token") || "";
  if (!sent || !sessionRow || !sessionRow.csrf) return false;
  return timingEqualStr(sent, sessionRow.csrf);
}


// ---- DEV_KEY, reduced to a machine token ----------------------------------
// No longer a user-facing credential. It survives only as break-glass account
// recovery and for curl-triggered ops reports. Constant-time comparison.
function checkMachineToken(request, env, body) {
  const key =
    (body && typeof body.devKey === "string" && body.devKey) ||
    request.headers.get("x-dev-key") ||
    "";
  return Boolean(env.DEV_KEY) && key.length > 0 && timingEqualStr(key, env.DEV_KEY);
}

// ===========================================================================
// AUTH ROUTES  —  /api/auth/*
// ===========================================================================

const esc = (s) =>
  String(s === null || s === undefined ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const authOrigin = (env, request) => {
  if (env.AUTH_ORIGIN) return String(env.AUTH_ORIGIN).replace(/\/+$/, "");
  // Never derived from the Host header in production (host-header injection);
  // this fallback only exists so local dev works without configuration.
  return new URL(request.url).origin;
};

function redirectTo(url, extraHeaders = []) {
  const headers = new Headers({ location: url, "cache-control": "no-store" });
  for (const c of extraHeaders) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

function jsonWithCookies(obj, cookies, status = 200) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
  });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(obj), { status, headers });
}

// Minimal self-contained page for the flows that must not depend on the app
// shell (magic-link and invite interstitials, which run pre-session).
// The same full robot the site uses everywhere (common.js mascotHTML), in the
// given mood, for pages this worker renders itself. These load /css/style.css,
// so the browser-side mood classes (and their animations) all work here.
function mascotStageHtml(mood) {
  if (!mood) return "";
  return (
    `<div class="mascot-stage${mood === "dance" ? " party" : ""}"><span class="mascot-scale">` +
    `<span class="ebot ${mood}" aria-hidden="true">` +
    '<span class="eb-antenna"></span>' +
    '<span class="eb-head"><i class="eb-eye"></i><i class="eb-eye"></i>' +
    '<i class="eb-tear l"></i><i class="eb-tear r"></i><i class="eb-sweat"></i>' +
    '<span class="eb-mouth"></span></span>' +
    '<span class="eb-body"></span>' +
    '<span class="eb-arm l"></span><span class="eb-arm r"></span>' +
    '<span class="eb-legs"><i></i><i></i></span>' +
    "</span></span></div>"
  );
}

function authShellPage(title, bodyHtml, status = 200, mood = "") {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title><link rel="stylesheet" href="/css/style.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"></head>
<body><div class="container"><div class="card auth-card">${mascotStageHtml(mood)}${bodyHtml}</div></div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } }
  );
}

const loginRedirect = (env, request, code, next) =>
  redirectTo(
    `${authOrigin(env, request)}/login.html?e=${encodeURIComponent(code)}` +
      (next ? `&next=${encodeURIComponent(next)}` : "")
  );

// Shape returned to the client for the signed-in user. Never includes the CSRF
// token (that travels in its own cookie) or anything password-related.
const publicStaff = (staff) => ({
  id: staff.id,
  email: staff.email,
  name: staff.name || "",
  role: staff.role,
  hasPassword: Boolean(staff.password_hash),
});

async function handleAuth(request, env, ctx, parts, url) {
  const action = parts[2] || "";
  const sub = parts[3] || "";
  const method = request.method;
  await ensureAuthTables(env);

  // Parse the body ONCE, branching on content-type. The magic-link and invite
  // interstitials submit real <form>s (urlencoded), everything else sends JSON;
  // calling request.json() first would consume the stream and leave formData()
  // with nothing to read.
  let body = {};
  if (method === "POST" || method === "PATCH") {
    const ct = String(request.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      body = await request.json().catch(() => ({}));
    } else if (ct.includes("form-urlencoded") || ct.includes("multipart/form-data")) {
      const form = await request.formData().catch(() => null);
      if (form) for (const [k, v] of form.entries()) body[k] = typeof v === "string" ? v : "";
    }
  }

  // Login CSRF: every auth mutation must originate from our own origin.
  if (method !== "GET" && method !== "HEAD" && !checkOrigin(request, env)) {
    audit(env, ctx, auditFrom(request, { type: "origin_reject", outcome: "deny", detail: "/api/auth/" + action }));
    return json({ error: "Request blocked: bad origin." }, 403);
  }

  // ---- Who am I ----------------------------------------------------------
  if (action === "me" && method === "GET") {
    const s = await readSession(request, env);
    if (!s) return json({ authenticated: false });
    return json({
      authenticated: true,
      user: publicStaff(s.staff),
      sessionMethod: s.session.method,
    });
  }

  // ---- Logout ------------------------------------------------------------
  if (action === "logout" && method === "POST") {
    const s = await readSession(request, env);
    if (s) {
      await revokeSession(env, s.session.id);
      audit(env, ctx, auditFrom(request, { type: "logout", staffId: s.staff.id, email: s.staff.email }));
    }
    return jsonWithCookies({ ok: true }, [clearCookie(env, "session"), clearCookie(env, "csrf")]);
  }

  // ---- Password login ----------------------------------------------------
  if (action === "login" && sub === "password" && method === "POST") {
    const ip = clientIp(request) || "unknown";

    // Rate limit BEFORE any hashing. Otherwise this endpoint is a CPU
    // amplifier: an attacker posting random emails would cost us a PBKDF2
    // derive each time.
    const rl = await rateLimit(env, "login:ip", ip, 20, 15 * 60);
    if (!rl.allowed) {
      audit(env, ctx, auditFrom(request, { type: "rate_limited", outcome: "deny", detail: "login" }));
      return tooManyRequests(rl.retryAfter);
    }

    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const generic = { error: "That email and password combination didn't work." };

    if (!isValidEmail(email) || !password) return json(generic, 401);

    const staff = await staffByEmail(env, email);

    if (staff && Number(staff.locked_until || 0) > Date.now()) {
      audit(env, ctx, auditFrom(request, { type: "login_locked", staffId: staff.id, email, outcome: "deny" }));
      return json(
        { error: "Too many failed attempts. This account is locked — try again later or use a sign-in link." },
        423
      );
    }

    if (!staff || staff.status !== "active" || !staff.password_hash) {
      // Uniform wall-clock delay rather than a dummy hash. setTimeout does not
      // consume CPU quota, so an unknown email cannot be distinguished by
      // timing AND cannot be used to burn our CPU budget.
      await new Promise((r) => setTimeout(r, 120));
      audit(env, ctx, auditFrom(request, {
        type: "login_fail",
        outcome: "deny",
        email: staff ? email : null,
        detail: staff ? "no password set or inactive" : "unknown email " + (await sha256Hex(email)).slice(0, 16),
      }));
      return json(generic, 401);
    }

    let result;
    try {
      result = await verifyPassword(env, password, staff.password_hash);
    } catch (e) {
      console.log("verifyPassword failed:", e && e.message);
      return json({ error: "Password sign-in is not configured on this server." }, 503);
    }

    if (!result.ok) {
      const lockedUntil = await registerLoginFailure(env, staff);
      audit(env, ctx, auditFrom(request, {
        type: "login_fail",
        staffId: staff.id,
        email,
        outcome: "deny",
        detail: lockedUntil > Date.now() ? "locked" : "bad password",
      }));
      return json(generic, 401);
    }

    if (result.needsRehash) {
      const fresh = await hashPassword(env, password);
      await env.CONVENTION_DB.prepare("UPDATE staff SET password_hash = ?, updated_at = ? WHERE id = ?")
        .bind(fresh, Date.now(), staff.id)
        .run();
    }

    await clearLoginFailures(env, staff.id);
    const created = await createSession(env, staff, "password", request);
    audit(env, ctx, auditFrom(request, { type: "login_ok", staffId: staff.id, email, detail: "password" }));
    return jsonWithCookies(
      { ok: true, user: publicStaff(staff), next: safeNext(body.next) },
      sessionCookieHeaders(env, created)
    );
  }

  // ---- Magic link: request -----------------------------------------------
  if (action === "magic" && sub === "start" && method === "POST") {
    const ip = clientIp(request) || "unknown";
    const email = normalizeEmail(body.email);
    const next = safeNext(body.next);

    // The wait token lets THIS tab poll /magic/wait until the emailed link is
    // approved. It is minted for every request — known, unknown, disabled, or
    // rate-limited — so the response is uniform and cannot be used to probe
    // for staff addresses. For an unknown email no row is ever written, so
    // its wait token simply polls "pending" until the page gives up.
    const bindId = randomToken(16);
    const uniform = json({ ok: true, mode: "link", wait: bindId });

    if (!isValidEmail(email)) return uniform;

    // Email-first sign-in: the page sends just the address and the server
    // answers how to continue. An active account WITH a password types it —
    // no email goes out unless the client asks explicitly (force: the
    // "email me a link instead" fallback for a forgotten password). Every
    // other case — no password, unknown, disabled — falls through to the
    // uniform link flow, so the one thing this branch reveals is "this
    // committee member uses a password"; accepted, with its own rate limit,
    // in exchange for a one-field sign-in screen.
    if (body.force !== true) {
      const probeRl = await rateLimit(env, "probe:ip", ip, 30, 15 * 60);
      if (!probeRl.allowed) return uniform;
      const existing = await staffByEmail(env, email);
      if (existing && existing.status === "active" && existing.password_hash) {
        return json({ ok: true, mode: "password" });
      }
    }

    const emailKey = (await sha256Hex(email)).slice(0, 32);
    const perEmail = await rateLimit(env, "magic:email", emailKey, 3, 60 * 60);
    const perIp = await rateLimit(env, "magic:ip", ip, 10, 60 * 60);
    const global = await rateLimit(env, "magic:day", istDate(0), 100, 24 * 60 * 60);
    if (!perEmail.allowed || !perIp.allowed || !global.allowed) return uniform;

    // The whole send runs in waitUntil so the response time is identical
    // whether or not the account exists — a stopwatch is as good an oracle as
    // a different status code.
    const work = (async () => {
      let staff = await staffByEmail(env, email);
      if (!staff) staff = await staffForEmail(env, ctx, email, request);
      if (!staff || staff.status === "disabled") {
        await audit(env, ctx, auditFrom(request, {
          type: "magic_unknown",
          outcome: "deny",
          detail: "no active staff for " + (await sha256Hex(email)).slice(0, 16),
        }));
        return;
      }

      const token = randomToken(32);
      const tokenHash = await sha256Hex(token);
      const csrf = randomToken(16);
      const now = Date.now();
      await env.CONVENTION_DB.prepare(
        `INSERT INTO magic_token (token_hash, email, purpose, next, csrf, bind_id, created_at, expires_at)
         VALUES (?, ?, 'login', ?, ?, ?, ?, ?)`
      )
        .bind(tokenHash, staff.email, next, csrf, bindId, now, now + MAGIC_TTL_MS)
        .run();

      // Recipient comes from the DATABASE ROW, never from the request body,
      // and nothing the caller supplied is echoed into the message. That is
      // what keeps this from being an open relay.
      const link = `${authOrigin(env, request)}/api/auth/magic/consume?token=${encodeURIComponent(token)}`;
      const html = mascotEmail({
        mood: "wave",
        logo: emailLogoUrl(env),
        title: "Approve your sign-in",
        intro:
          "The little mascot spotted you at the door and is waving you in — tap the button to approve the sign-in you just asked for. It works exactly once and expires in 15 minutes, so don't leave it waiting too long.",
        button: { href: link, label: "Yep, that was me — approve sign-in" },
        bodyHtml:
          '<p style="color:#4b5563;line-height:1.65;text-align:center;margin:16px 0 0">' +
          "Open it anywhere — even in your mail app's weird little built-in browser, it still counts. " +
          "The page where you asked to sign in notices the approval and signs you in there all by itself. The mascot trained it well.</p>",
        note:
          "Didn't ask to sign in? Just ignore this email — nobody can reach your account without it, and the mascot will keep guarding the door like its life depends on it. (It does. It lives there.)",
      });
      if (env.AUTH_LOG_LINKS === "1" || !env.MAILCHANNELS_API_KEY) {
        console.log("[auth] magic link for " + staff.email + ": " + link);
      }
      const sent = await sendMail(env, staff.email, "Approve your sign-in — the mascot is holding the door", html, { toName: staff.name || "" });
      await audit(env, ctx, auditFrom(request, {
        type: "magic_sent",
        staffId: staff.id,
        email: staff.email,
        outcome: sent.ok ? "ok" : "error",
        detail: sent.note,
      }));
    })();

    if (ctx && ctx.waitUntil) ctx.waitUntil(work);
    return uniform;
  }

  // ---- Magic link: wait for approval -------------------------------------
  // Polled by the login page after /magic/start. The session is minted HERE,
  // in the browser the person is actually sitting in front of — the emailed
  // link only flips approved_at. This is the answer to "the link doesn't work
  // on my phone": mail apps open links in an isolated in-app browser, so a
  // session minted there would never reach the real one.
  //
  // Everything that is not an approved, unclaimed, unexpired token answers
  // "pending" — including wait tokens that never matched a row and rows that
  // have expired. Answering "expired" only for real accounts would reopen the
  // enumeration oracle; the login page keeps its own 15-minute clock instead.
  if (action === "magic" && sub === "wait" && method === "POST") {
    const ip = clientIp(request) || "unknown";
    // Generous — one waiting tab polls every ~3s for up to 15 minutes — but
    // bounded so the endpoint cannot be used as a free D1 read loop.
    const rl = await rateLimit(env, "wait:ip", ip, 1200, 15 * 60);
    if (!rl.allowed) return tooManyRequests(rl.retryAfter);

    const wait = String(body.wait || "");
    const pending = json({ status: "pending" });
    if (!wait || wait.length > 64) return pending;

    const row = await env.CONVENTION_DB.prepare(
      `SELECT * FROM magic_token
       WHERE bind_id = ? AND used_at IS NULL AND approved_at IS NOT NULL AND expires_at > ?
       LIMIT 1`
    )
      .bind(wait, Date.now())
      .first();
    if (!row) return pending;

    // Single-use, same conditional-update guarantee as the link itself.
    const claim = await env.CONVENTION_DB.prepare(
      "UPDATE magic_token SET used_at = ? WHERE token_hash = ? AND used_at IS NULL"
    )
      .bind(Date.now(), row.token_hash)
      .run();
    if (!claim.meta || claim.meta.changes !== 1) return pending;

    let staff = await staffByEmail(env, row.email);
    if (!staff) staff = await staffForEmail(env, ctx, row.email, request);
    if (!staff || staff.status === "disabled") return json({ error: "That account can't sign in." }, 403);

    if (staff.status === "invited") {
      await env.CONVENTION_DB.prepare("UPDATE staff SET status = 'active', updated_at = ? WHERE id = ?")
        .bind(Date.now(), staff.id)
        .run();
      staff = await staffById(env, staff.id);
    }

    await clearLoginFailures(env, staff.id);
    const created = await createSession(env, staff, "magic", request);
    audit(env, ctx, auditFrom(request, { type: "magic_consumed", staffId: staff.id, email: staff.email, detail: "approved remotely" }));
    return jsonWithCookies(
      {
        ok: true,
        status: "approved",
        user: publicStaff(staff),
        next: safeNext(row.next),
        // No password yet means the emailed link is their only way in; the
        // client routes them to the account page to set one before anything else.
        setupRequired: !staff.password_hash,
      },
      sessionCookieHeaders(env, created)
    );
  }

  // ---- Magic link: interstitial ------------------------------------------
  // GET must NOT mint a session. Outlook Safe Links, Proofpoint and browser
  // prefetchers all fetch the URL before a human clicks, which would burn the
  // single-use token and produce "link expired" for someone who never clicked.
  if (action === "magic" && sub === "consume" && method === "GET") {
    const token = url.searchParams.get("token") || "";
    const row = await env.CONVENTION_DB.prepare(
      "SELECT * FROM magic_token WHERE token_hash = ?"
    )
      .bind(await sha256Hex(token))
      .first();

    if (!row || row.used_at || Number(row.expires_at) < Date.now()) {
      return authShellPage(
        "Link expired",
        `<h2 style="margin-top:0">This link has expired</h2>
         <p class="muted">Sign-in links only live for 15 minutes and work exactly once — this one had a short but beautiful life. The mascot is a little sad about it too. Grab a fresh one below.</p>
         <a class="btn primary" href="/login.html">Send me a fresh link</a>`,
        410,
        "sad"
      );
    }

    // Link already approved but the waiting tab hasn't claimed it yet —
    // re-opening the email link shouldn't look like an error.
    if (row.approved_at) {
      return authShellPage(
        "Sign-in approved",
        `<h2 style="margin-top:0">Sign-in approved &#10003;</h2>
         <p class="muted">Now go back to the page where you asked to sign in — it signs itself in, no clicking required. You can close this window while the mascot celebrates in here alone, as usual.</p>`,
        200,
        "dance"
      );
    }

    return authShellPage(
      "Approve sign-in",
      `<h2 style="margin-top:0">Approve this sign-in?</h2>
       <p class="muted">You're approving a sign-in for <b class="auth-email">${esc(row.email)}</b>. The mascot is waving so hard its little arm might fall off.</p>
       <form method="POST" action="/api/auth/magic/confirm">
         <input type="hidden" name="token" value="${esc(token)}">
         <input type="hidden" name="csrf" value="${esc(row.csrf)}">
         <button class="btn primary" type="submit" style="width:100%">Approve sign-in</button>
       </form>
       <p class="muted" style="font-size:13px;margin-bottom:0">Didn't request this? Just close the page — nothing has happened yet, and nothing will.</p>`,
      200,
      "wave"
    );
  }

  // ---- Magic link: confirm -----------------------------------------------
  if (action === "magic" && sub === "confirm" && method === "POST") {
    // The interstitial posts a real form; checkOrigin above is what protects it.
    const token = body.token;
    const csrf = body.csrf;

    const tokenHash = await sha256Hex(String(token || ""));
    const row = await env.CONVENTION_DB.prepare("SELECT * FROM magic_token WHERE token_hash = ?")
      .bind(tokenHash)
      .first();

    if (!row || row.used_at || Number(row.expires_at) < Date.now() || !timingEqualStr(String(csrf || ""), row.csrf)) {
      audit(env, ctx, auditFrom(request, { type: "magic_invalid", outcome: "deny" }));
      return loginRedirect(env, request, "expired");
    }

    // Emailed links carry a bind_id tying them to the tab that requested
    // them. Confirming such a link only APPROVES it — the waiting tab polls
    // /magic/wait, claims the token and mints the session over there. No
    // session is created in this window, so it doesn't matter that mail apps
    // open links in an isolated in-app browser.
    if (row.bind_id) {
      const staff = await staffByEmail(env, row.email);
      if (!staff || staff.status === "disabled") return loginRedirect(env, request, "not_staff");

      const approve = await env.CONVENTION_DB.prepare(
        "UPDATE magic_token SET approved_at = ? WHERE token_hash = ? AND used_at IS NULL AND approved_at IS NULL"
      )
        .bind(Date.now(), tokenHash)
        .run();
      if (!approve.meta || approve.meta.changes !== 1) {
        audit(env, ctx, auditFrom(request, { type: "magic_invalid", outcome: "deny", detail: "already approved or used" }));
        return loginRedirect(env, request, "expired");
      }

      audit(env, ctx, auditFrom(request, { type: "magic_approved", staffId: staff.id, email: staff.email }));
      return authShellPage(
        "Sign-in approved",
        `<h2 style="margin-top:0">Sign-in approved &#10003;</h2>
         <p class="muted">Now go back to the page where you asked to sign in — it signs itself in within a few seconds, no clicking required. You can close this window while the mascot celebrates in here alone, as usual.</p>`,
        200,
        "dance"
      );
    }

    // No bind_id: break-glass links (and other tokens minted outside the
    // login page) have no waiting tab, so the only useful place to sign in
    // is right here. Single-use, enforced by D1's strong consistency:
    // exactly one caller can flip used_at from NULL.
    const claim = await env.CONVENTION_DB.prepare(
      "UPDATE magic_token SET used_at = ? WHERE token_hash = ? AND used_at IS NULL"
    )
      .bind(Date.now(), tokenHash)
      .run();
    if (!claim.meta || claim.meta.changes !== 1) {
      audit(env, ctx, auditFrom(request, { type: "magic_invalid", outcome: "deny", detail: "already used" }));
      return loginRedirect(env, request, "expired");
    }

    let staff = await staffByEmail(env, row.email);
    if (!staff) staff = await staffForEmail(env, ctx, row.email, request);
    if (!staff || staff.status === "disabled") return loginRedirect(env, request, "not_staff");

    if (staff.status === "invited") {
      await env.CONVENTION_DB.prepare("UPDATE staff SET status = 'active', updated_at = ? WHERE id = ?")
        .bind(Date.now(), staff.id)
        .run();
      staff = await staffById(env, staff.id);
    }

    await clearLoginFailures(env, staff.id);
    const created = await createSession(env, staff, "magic", request);
    audit(env, ctx, auditFrom(request, { type: "magic_consumed", staffId: staff.id, email: staff.email }));
    return redirectTo(authOrigin(env, request) + safeNext(row.next), sessionCookieHeaders(env, created));
  }

  // ---- Google SSO: start -------------------------------------------------
  if (action === "google" && sub === "start" && method === "GET") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return loginRedirect(env, request, "google_unconfigured");
    }
    const rl = await rateLimit(env, "oauth:ip", clientIp(request) || "unknown", 20, 15 * 60);
    if (!rl.allowed) return tooManyRequests(rl.retryAfter);

    const verifier = randomToken(32);
    const challenge = b64urlEncode(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
    );
    const state = randomToken(32);
    const nonce = randomToken(16);
    const now = Date.now();

    await env.CONVENTION_DB.prepare(
      `INSERT INTO oauth_tx (state, verifier, nonce, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(state, verifier, nonce, safeNext(url.searchParams.get("next")), now, now + OAUTH_TTL_MS)
      .run();

    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    auth.searchParams.set("redirect_uri", authOrigin(env, request) + "/api/auth/google/callback");
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", "openid email profile");
    auth.searchParams.set("state", state);
    auth.searchParams.set("nonce", nonce);
    auth.searchParams.set("code_challenge", challenge);
    auth.searchParams.set("code_challenge_method", "S256");
    auth.searchParams.set("prompt", "select_account");
    // No refresh token: one we never use is a liability we'd have to store.
    auth.searchParams.set("access_type", "online");

    audit(env, ctx, auditFrom(request, { type: "google_start" }));
    // SameSite=Lax is required — Strict is not sent on the top-level redirect
    // back from accounts.google.com, so the flow would break every time.
    return redirectTo(auth.toString(), [buildCookie(env, "oauth", state, { maxAge: 600, httpOnly: true })]);
  }

  // ---- Google SSO: callback ----------------------------------------------
  if (action === "google" && sub === "callback" && method === "GET") {
    if (url.searchParams.get("error")) return loginRedirect(env, request, "cancelled");

    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    const cookieState = parseCookies(request.headers.get("Cookie"))[cookieName(env, "oauth")] || "";
    const clearOauth = [clearCookie(env, "oauth")];

    // The state cookie binds the callback to the browser that started the
    // flow — this is the anti-login-CSRF control.
    if (!state || !cookieState || !timingEqualStr(state, cookieState)) {
      audit(env, ctx, auditFrom(request, { type: "google_state_mismatch", outcome: "deny" }));
      return redirectTo(`${authOrigin(env, request)}/login.html?e=state`, clearOauth);
    }

    const tx = await env.CONVENTION_DB.prepare("SELECT * FROM oauth_tx WHERE state = ?").bind(state).first();
    await env.CONVENTION_DB.prepare("DELETE FROM oauth_tx WHERE state = ?").bind(state).run();
    if (!tx || Number(tx.expires_at) < Date.now()) {
      return redirectTo(`${authOrigin(env, request)}/login.html?e=expired`, clearOauth);
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: authOrigin(env, request) + "/api/auth/google/callback",
        grant_type: "authorization_code",
        code_verifier: tx.verifier,
      }),
    });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokens.id_token) {
      audit(env, ctx, auditFrom(request, { type: "google_token_fail", outcome: "error", detail: "http " + tokenRes.status }));
      return redirectTo(`${authOrigin(env, request)}/login.html?e=google`, clearOauth);
    }

    // The ID token came straight from Google's token endpoint over a TLS
    // channel we authenticated with client_id + client_secret, so per OIDC
    // Core 3.1.3.7 the signature does not need separate verification. Claims
    // still do.
    let claims;
    try {
      const payload = String(tokens.id_token).split(".")[1];
      claims = JSON.parse(new TextDecoder().decode(b64urlDecodeBytes(payload)));
    } catch {
      return redirectTo(`${authOrigin(env, request)}/login.html?e=google`, clearOauth);
    }

    const now = Math.floor(Date.now() / 1000);
    const issuerOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    if (
      !issuerOk ||
      claims.aud !== env.GOOGLE_CLIENT_ID ||
      Number(claims.exp) <= now ||
      Number(claims.iat) > now + 300 ||
      claims.nonce !== tx.nonce ||
      claims.email_verified !== true // unverified email is an impersonation vector
    ) {
      audit(env, ctx, auditFrom(request, { type: "google_claim_reject", outcome: "deny" }));
      return redirectTo(`${authOrigin(env, request)}/login.html?e=google`, clearOauth);
    }

    if (env.GOOGLE_HD && claims.hd !== env.GOOGLE_HD) {
      return redirectTo(`${authOrigin(env, request)}/login.html?e=not_staff`, clearOauth);
    }

    const email = normalizeEmail(claims.email);
    const sub_ = String(claims.sub);

    // Match on google_sub first — it is the only stable identifier. A Workspace
    // admin can reassign an email address to a different human; sub never
    // changes and never transfers.
    let staff = await env.CONVENTION_DB.prepare("SELECT * FROM staff WHERE google_sub = ?").bind(sub_).first();

    if (!staff) {
      staff = await staffByEmail(env, email);
      if (!staff) staff = await staffForEmail(env, ctx, email, request);

      if (staff && staff.google_sub && staff.google_sub !== sub_) {
        // Someone else's Google account claims this staff email. Never rebind.
        audit(env, ctx, auditFrom(request, { type: "google_sub_conflict", staffId: staff.id, email, outcome: "deny" }));
        return redirectTo(`${authOrigin(env, request)}/login.html?e=conflict`, clearOauth);
      }
      if (staff) {
        await env.CONVENTION_DB.prepare(
          "UPDATE staff SET google_sub = ?, name = CASE WHEN name = '' THEN ? ELSE name END, updated_at = ? WHERE id = ? AND google_sub IS NULL"
        )
          .bind(sub_, String(claims.name || ""), Date.now(), staff.id)
          .run();
        staff = await staffById(env, staff.id);
      }
    }

    if (!staff) {
      // Do NOT auto-provision. Attendee PII sits behind the staff role, and
      // anyone with a Gmail address is not staff.
      audit(env, ctx, auditFrom(request, { type: "google_unknown", email, outcome: "deny" }));
      return redirectTo(`${authOrigin(env, request)}/login.html?e=not_staff`, clearOauth);
    }
    if (staff.status === "disabled") {
      return redirectTo(`${authOrigin(env, request)}/login.html?e=disabled`, clearOauth);
    }
    if (staff.status === "invited") {
      await env.CONVENTION_DB.prepare("UPDATE staff SET status = 'active', updated_at = ? WHERE id = ?")
        .bind(Date.now(), staff.id)
        .run();
      staff = await staffById(env, staff.id);
    }

    await clearLoginFailures(env, staff.id);
    const created = await createSession(env, staff, "google", request);
    audit(env, ctx, auditFrom(request, { type: "google_ok", staffId: staff.id, email: staff.email }));
    return redirectTo(authOrigin(env, request) + safeNext(tx.next), [
      ...clearOauth,
      ...sessionCookieHeaders(env, created),
    ]);
  }

  // ---- Break-glass sign-in link (DEV_KEY) --------------------------------
  // The recovery path when email or Google is the thing that is broken. It
  // does NOT grant access — the email must already be on an allowlist in
  // wrangler.toml — it only mints a sign-in link for someone who is already
  // permitted. A break-glass used SILENTLY is a backdoor; this one is capped
  // at 3/day, always audited, and always emails the ops address.
  if (action === "bootstrap" && method === "POST") {
    if (!checkMachineToken(request, env, body)) return json({ error: "Forbidden" }, 403);

    const rl = await rateLimit(env, "bootstrap:day", istDate(0), 3, 24 * 60 * 60);
    if (!rl.allowed) {
      audit(env, ctx, auditFrom(request, { type: "devkey_bootstrap", outcome: "deny", detail: "daily cap" }));
      return tooManyRequests(rl.retryAfter);
    }

    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) return json({ error: "A valid email is required." }, 400);

    const role = resolveRoleFromConfig(env, email);
    if (!role) {
      audit(env, ctx, auditFrom(request, { type: "devkey_bootstrap", outcome: "deny", detail: "not on allowlist" }));
      return json(
        { error: "That email is not in STAFF_EMAILS or DEVELOPER_EMAILS. Add it in wrangler.toml and redeploy." },
        403
      );
    }

    const staff = await staffForEmail(env, ctx, email, request);
    if (!staff) return json({ error: "Could not create the account." }, 500);
    await clearLoginFailures(env, staff.id);

    const token = randomToken(32);
    const now = Date.now();
    await env.CONVENTION_DB.prepare(
      `INSERT INTO magic_token (token_hash, email, purpose, next, csrf, bind_id, created_at, expires_at)
       VALUES (?, ?, 'login', '/index.html', ?, '', ?, ?)`
    )
      .bind(await sha256Hex(token), staff.email, randomToken(16), now, now + MAGIC_TTL_MS)
      .run();
    const loginLink = `${authOrigin(env, request)}/api/auth/magic/consume?token=${encodeURIComponent(token)}`;

    audit(env, ctx, auditFrom(request, { type: "devkey_bootstrap", staffId: staff.id, email, detail: "role " + role }));
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(
        sendOpsEmail(
          env,
          "Break-glass account recovery used",
          `<p>The DEV_KEY break-glass endpoint granted <b>${esc(role)}</b> to <b>${esc(email)}</b>.</p>
           <p>IP: ${esc(clientIp(request))}</p>
           <p>If this wasn't you, rotate DEV_KEY immediately.</p>`
        )
      );
    }
    return json({ ok: true, email, role, loginLink, expiresInMinutes: Math.round(MAGIC_TTL_MS / 60000) });
  }

  // ---- Everything below requires a session -------------------------------
  const s = await readSession(request, env);
  if (!s) return json({ error: "Sign in to continue." }, 401);

  // Mutations additionally need the session-bound CSRF token.
  if (method !== "GET" && method !== "HEAD" && !checkCsrf(request, s.session)) {
    audit(env, ctx, auditFrom(request, { type: "csrf_reject", staffId: s.staff.id, outcome: "deny" }));
    return json({ error: "Request blocked: missing or invalid CSRF token." }, 403);
  }

  // ---- Set / change own password -----------------------------------------
  if (action === "password" && sub === "set" && method === "POST") {
    const rl = await rateLimit(env, "pwset:staff", s.staff.id, 5, 60 * 60);
    if (!rl.allowed) return tooManyRequests(rl.retryAfter);

    const password = String(body.password || "");

    // Changing an existing password requires the current one, so a stolen
    // session cannot silently lock the real owner out.
    if (s.staff.password_hash) {
      const cur = await verifyPassword(env, String(body.currentPassword || ""), s.staff.password_hash);
      if (!cur.ok) return json({ error: "Your current password didn't match." }, 401);
    }

    const policy = passwordPolicyError(password, s.staff.email);
    if (policy) return json({ error: policy }, 400);
    if (await isPwnedPassword(password)) {
      return json({ error: "That password has appeared in a public data breach. Please choose another." }, 400);
    }

    // s.staff was read before the update, so this still reflects the old state.
    const isChange = Boolean(s.staff.password_hash);

    let hash;
    try {
      hash = await hashPassword(env, password);
    } catch (e) {
      return json({ error: "Password sign-in is not configured on this server." }, 503);
    }
    await env.CONVENTION_DB.prepare(
      "UPDATE staff SET password_hash = ?, pwd_changed_at = ?, updated_at = ? WHERE id = ?"
    )
      .bind(hash, Date.now(), Date.now(), s.staff.id)
      .run();

    // Every other session for this user dies, and this one rotates.
    await revokeAllSessions(env, s.staff.id, s.session.id);
    const created = await rotateSession(env, s.session.id, s.staff, s.session.method, request);
    audit(env, ctx, auditFrom(request, {
      type: isChange ? "password_changed" : "password_set",
      staffId: s.staff.id,
      email: s.staff.email,
    }));

    // Tell the owner by email — celebration for a first password, a calm
    // security note for a change. Fire-and-forget: mail trouble must never
    // fail the request that already succeeded.
    const when = istClock();
    const mailHtml = isChange
      ? mascotEmail({
          mood: "happy",
          logo: emailLogoUrl(env),
          title: "Your password was changed",
          intro:
            "Your Convention password was changed on " + when + " (IST). " +
            "Every other signed-in device was signed out at the same moment, so only the person who changed it is still in. " +
            "The mascot went around and double-checked all the locks.",
          note:
            "Wasn't you? Go to the sign-in page, choose 'email me a sign-in link', set a fresh password, and tell the organising committee straight away. The mascot will stand guard until then.",
        })
      : mascotEmail({
          mood: "dance",
          logo: emailLogoUrl(env),
          title: "Password set — you're all locked in (the good kind of locked)!",
          intro:
            "Your account got its password on " + when + " (IST). Every other signed-in device was signed out at the same moment, so only the device that set it is still in. " +
            "The mascot witnessed the whole thing and immediately broke into a celebratory dance. There was confetti. Nobody knows where it got confetti.",
          bodyHtml:
            '<p style="color:#4b5563;line-height:1.65;text-align:center;margin:16px 0 0">' +
            "From here on out you can sign in with your email and this password. And if your brain ever deletes the password — happens to the best of us — " +
            "the sign-in page can always email you a link instead. No shame, no drama.</p>",
          note: "Wasn't you? Tell the organising committee straight away — this one matters.",
        });
    const mailWork = sendMail(
      env,
      s.staff.email,
      isChange ? "Your Convention password was changed" : "Your Convention password is set 🎉",
      mailHtml,
      { toName: s.staff.name || "" }
    );
    if (ctx && ctx.waitUntil) ctx.waitUntil(mailWork);

    return jsonWithCookies({ ok: true }, sessionCookieHeaders(env, created));
  }

  // ---- Session listing / revocation --------------------------------------
  if (action === "sessions" && method === "GET") {
    const { results } = await env.CONVENTION_DB.prepare(
      `SELECT id, method, created_at, last_seen_at, ip, ua FROM session
       WHERE staff_id = ? AND revoked_at IS NULL AND absolute_exp > ?
       ORDER BY last_seen_at DESC`
    )
      .bind(s.staff.id, Date.now())
      .all();
    return json({
      sessions: (results || []).map((r) => ({
        id: r.id, // already a hash — safe to expose
        method: r.method,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        ip: r.ip,
        ua: r.ua,
        current: r.id === s.session.id,
      })),
    });
  }

  if (action === "sessions" && method === "DELETE") {
    if (sub) {
      const row = await env.CONVENTION_DB.prepare("SELECT staff_id FROM session WHERE id = ?").bind(sub).first();
      if (!row) return json({ error: "Not found." }, 404);
      // You can only ever revoke your own sessions. Access itself is managed
      // in config, so there is nothing here for one person to do to another.
      if (row.staff_id !== s.staff.id) return json({ error: "Not found." }, 404);
      await revokeSession(env, sub);
      audit(env, ctx, auditFrom(request, { type: "session_revoked", staffId: s.staff.id, detail: sub.slice(0, 16) }));
      return json({ ok: true });
    }
    await revokeAllSessions(env, s.staff.id, s.session.id);
    audit(env, ctx, auditFrom(request, { type: "session_revoked", staffId: s.staff.id, detail: "all others" }));
    return json({ ok: true });
  }

  // ---- Staff directory (developers) ---------------------------------------
  // Read-and-delete only. ADDING someone still happens in wrangler.toml —
  // the allowlist there is the authority on who may sign in, so deleting a
  // row here ends their sessions and wipes their password, but an email that
  // is still in STAFF_EMAILS/DEVELOPER_EMAILS can simply sign in again. The
  // response says so rather than pretending the delete was a full revocation.
  if (action === "staff" && method === "GET" && !sub) {
    if (s.staff.role !== "developer") return json({ error: "Developer access required." }, 403);
    const { results } = await env.CONVENTION_DB.prepare(
      `SELECT id, email, name, status, password_hash IS NOT NULL AS has_password,
              last_login_at, created_at FROM staff ORDER BY created_at ASC`
    ).all();
    return json({
      staff: (results || []).map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name || "",
        // Effective role comes from config, same as every request; a stale
        // DB value (or a de-listed email) must not be presented as real.
        role: resolveRoleFromConfig(env, r.email),
        status: r.status,
        hasPassword: Boolean(r.has_password),
        lastLoginAt: r.last_login_at,
        createdAt: r.created_at,
        current: r.id === s.staff.id,
      })),
    });
  }

  if (action === "staff" && method === "DELETE" && sub) {
    if (s.staff.role !== "developer") return json({ error: "Developer access required." }, 403);
    if (sub === s.staff.id) return json({ error: "You can't delete your own account." }, 400);
    const target = await staffById(env, sub);
    if (!target) return json({ error: "Not found." }, 404);

    await revokeAllSessions(env, target.id);
    await env.CONVENTION_DB.batch([
      env.CONVENTION_DB.prepare("DELETE FROM magic_token WHERE email = ?").bind(target.email),
      env.CONVENTION_DB.prepare("DELETE FROM staff WHERE id = ?").bind(target.id),
    ]);
    audit(env, ctx, auditFrom(request, {
      type: "staff_deleted",
      staffId: s.staff.id,
      email: target.email,
      detail: "deleted by " + s.staff.email,
    }));

    // The person deserves to know — and the mascot is heartbroken about it.
    // Fire-and-forget so a mail hiccup never fails the delete itself.
    const byeWork = sendMail(
      env,
      target.email,
      "Your Convention account was removed",
      mascotEmail({
        mood: "sad",
        logo: emailLogoUrl(env),
        title: "Your account was removed",
        intro:
          "Your staff access on the Convention site was removed on " + istClock() +
          " (IST). You've been signed out everywhere and your password was cleared. The mascot watched it happen and is honestly not okay about it.",
        note:
          "Think this was a mistake? Reach out to the organising committee — they can let you right back in. The mascot is keeping your seat warm just in case.",
      }),
      { toName: target.name || "" }
    );
    if (ctx && ctx.waitUntil) ctx.waitUntil(byeWork);

    const stillListed = resolveRoleFromConfig(env, target.email);
    return json({
      ok: true,
      note: stillListed
        ? "Their email is still in wrangler.toml, so they can sign in again — remove it there to fully revoke access."
        : "",
    });
  }

  // ---- Audit log (developers) ---------------------------------------------
  if (action === "events" && method === "GET") {
    if (s.staff.role !== "developer") return json({ error: "Developer access required." }, 403);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
    const type = url.searchParams.get("type");
    const q = type
      ? env.CONVENTION_DB.prepare("SELECT * FROM auth_event WHERE type = ? ORDER BY at DESC LIMIT ?").bind(type, limit)
      : env.CONVENTION_DB.prepare("SELECT * FROM auth_event ORDER BY at DESC LIMIT ?").bind(limit);
    const { results } = await q.all();
    // Reading the audit log is itself audited.
    audit(env, ctx, auditFrom(request, { type: "audit_read", staffId: s.staff.id }));
    return json({ events: results || [] });
  }

  return json({ error: "Unknown auth route." }, 404);
}

// ===========================================================================
// API AUTHORIZATION  —  default deny
// ===========================================================================
//
// Each entry is [method, resource, minimum role, optional sub-path matcher].
// "*" matches any method. The sub matcher receives the split path parts and
// returns true when the rule applies.
//
// This table is the security boundary. The nav in common.js mirrors it for
// cosmetics only.
const API_POLICY = [
  // Committee work — attendee PII and money. Every one of these was
  // completely open to the internet before.
  ["GET", "registrations", "staff"],
  ["PATCH", "registrations", "staff"],
  ["DELETE", "registrations", "staff"],
  ["GET", "expenses", "staff"],
  ["POST", "expenses", "staff"],
  ["DELETE", "expenses", "staff"],
  ["GET", "dashboard", "staff"],

  // Reflections: reading stays public (see isPublicApi — Meta fetches the
  // card image when sending the daily template). Writing, and the paid
  // broadcast that costs money per recipient, are developer-only.
  ["POST", "reflections", "developer"],
  ["DELETE", "reflections", "developer"],

  // Developer surfaces. The knowledge base is injected into every chat system
  // prompt, and the ops reports expose Deepgram balances, Cloudflare
  // analytics and full financials, and can send email.
  ["*", "knowledge", "developer"],
  ["*", "report", "developer"],
  ["*", "whatsapp", "developer"], // /api/whatsapp/status; the webhook routes earlier
];

// Routes that must stay reachable without a session, with the reason.
function isPublicApi(method, resource, parts) {
  // Public site data.
  if (resource === "pricing" && method === "GET") return true;

  // Anyone can register — that is the point of the site.
  if (resource === "registrations" && method === "POST" && !parts[2]) return true;

  // "I'm back from Razorpay without paying" — the client pings this and the
  // pending ticket email goes out. Safe public: needs the unguessable
  // registration UUID, only ever sends the pending flavour, only once, and
  // only while the booking is actually unpaid.
  if (resource === "registrations" && method === "POST" && parts[2] && parts[3] === "notify")
    return true;

  // The reflections list is the public WhatsApp-channel landing content, and
  // Meta itself fetches the card image when sending the daily template, so
  // that URL can never require a session.
  if (resource === "reflections" && method === "GET") return true;
  if (resource === "reflections" && method === "POST" && parts[3] === "image") return false;

  // Payment: create-order now prices server-side from the stored registration,
  // and verify is authenticated by Razorpay's HMAC signature.
  if (resource === "payment" && method === "POST") return true;

  // Anonymous visitor features. Rate limits, not sessions, are the control.
  if (resource === "chat" && method === "POST") return true;
  if (resource === "tts" && method === "POST") return true;
  if (resource === "contact" && method === "POST") return true;

  return false;
}

function policyRoleFor(method, resource, parts) {
  for (const [m, res, role, matcher] of API_POLICY) {
    if (res !== resource) continue;
    if (m !== "*" && m !== method) continue;
    if (matcher && !matcher(parts)) continue;
    return role;
  }
  return null;
}

async function authorizeApi(request, env, ctx, { method, resource, parts, body, url }) {
  // CSRF layer 1: every mutation must come from our own origin. Browsers
  // always send Origin on non-GET fetches, so rejecting when both Origin and
  // Referer are missing is the correct fail-closed default.
  if (!checkOrigin(request, env)) {
    audit(env, ctx, auditFrom(request, { type: "origin_reject", outcome: "deny", detail: method + " /api/" + resource }));
    return { response: json({ error: "Request blocked: bad origin." }, 403) };
  }

  // CSRF layer 3: HTML forms cannot send application/json without a CORS
  // preflight, which is never granted.
  if (!checkJsonContentType(request)) {
    return { response: json({ error: "Expected content-type: application/json." }, 415) };
  }

  const needed = policyRoleFor(method, resource, parts);

  if (!needed) {
    if (isPublicApi(method, resource, parts)) return { response: null, session: await readSession(request, env) };
    // Unknown or unlisted route: deny rather than fall through to a 404, so a
    // new endpoint cannot ship open by accident.
    return { response: json({ error: "Not found." }, 404) };
  }

  // The ops report endpoints stay reachable from curl/monitoring with the
  // machine token. They are the only place DEV_KEY still authorises anything
  // besides break-glass recovery, and they expose no attendee PII.
  if (resource === "report" && checkMachineToken(request, env, body)) {
    audit(env, ctx, auditFrom(request, { type: "devkey_used", detail: method + " /api/" + resource }));
    return { response: null, session: null };
  }

  const s = await readSession(request, env);
  if (!s) {
    return { response: json({ error: "Sign in to continue." }, 401) };
  }

  // CSRF layer 2: the token is compared against the session row in the
  // database, not against the cookie, so it cannot be forged by anyone who can
  // merely set cookies.
  if (method !== "GET" && method !== "HEAD" && !checkCsrf(request, s.session)) {
    audit(env, ctx, auditFrom(request, { type: "csrf_reject", staffId: s.staff.id, outcome: "deny" }));
    return { response: json({ error: "Request blocked: missing or invalid CSRF token." }, 403) };
  }

  if (!roleAtLeast(s.staff.role, needed)) {
    audit(env, ctx, auditFrom(request, {
      type: "authz_deny",
      staffId: s.staff.id,
      email: s.staff.email,
      outcome: "deny",
      detail: `${method} /api/${resource} needs ${needed}, has ${s.staff.role}`,
    }));
    return { response: json({ error: `This action needs ${needed} access.` }, 403) };
  }

  return { response: null, session: s };
}

// ---- Spend / abuse limits for the expensive public endpoints --------------
//
// Signed-in staff get a much higher ceiling than anonymous visitors, since the
// realistic threat is an unauthenticated loop draining paid credit.
async function applySpendLimits(env, ctx, request, { method, resource, parts, session }) {
  if (method !== "POST") return null;
  const ip = clientIp(request) || "unknown";
  const staff = Boolean(session);
  const day = istDate(0);

  const deny = async (label, r) => {
    audit(env, ctx, auditFrom(request, { type: "rate_limited", outcome: "deny", detail: label }));
    return tooManyRequests(r.retryAfter);
  };

  if (resource === "tts") {
    // Deepgram is billed per character and the digest only warns AFTER the
    // credit has already been spent.
    const perIp = await rateLimit(env, "tts:ip", ip, staff ? 120 : 30, 60 * 60);
    if (!perIp.allowed) return deny("tts:ip", perIp);
    const global = await rateLimit(env, "tts:day", day, 800, 24 * 60 * 60);
    if (!global.allowed) return deny("tts:day", global);
  }

  if (resource === "chat") {
    const perIp = await rateLimit(env, "chat:ip", ip, staff ? 300 : 60, 60 * 60);
    if (!perIp.allowed) return deny("chat:ip", perIp);
    const global = await rateLimit(env, "chat:day", day, 3000, 24 * 60 * 60);
    if (!global.allowed) return deny("chat:day", global);
  }

  if (resource === "contact") {
    // An unauthenticated mail relay sending as noreply@biaac.com — the tightest
    // limit on the site, because abuse here burns the sending domain.
    const perIp = await rateLimit(env, "contact:ip", ip, 3, 24 * 60 * 60);
    if (!perIp.allowed) return deny("contact:ip", perIp);
    const global = await rateLimit(env, "contact:day", day, 50, 24 * 60 * 60);
    if (!global.allowed) return deny("contact:day", global);
  }

  // Each successful registration can fire a PAID WhatsApp confirmation.
  if (resource === "registrations" && !parts[2]) {
    const perIp = await rateLimit(env, "reg:ip", ip, 5, 60 * 60);
    if (!perIp.allowed) return deny("reg:ip", perIp);
  }

  if (resource === "payment" && parts[2] === "create-order") {
    const perIp = await rateLimit(env, "order:ip", ip, 10, 60 * 60);
    if (!perIp.allowed) return deny("order:ip", perIp);
  }

  if (resource === "registrations" && parts[3] === "notify") {
    const perIp = await rateLimit(env, "notify:ip", ip, 10, 60 * 60);
    if (!perIp.allowed) return deny("notify:ip", perIp);
  }

  return null;
}

// ===========================================================================
// SECURITY HEADERS
// ===========================================================================
//
// The site previously sent none of these.
//
// script-src still needs 'unsafe-inline' because every page carries a large
// inline <script> block. That weakens script-src specifically — but the other
// directives are not weakened by it and are worth having on day one:
//   base-uri 'none'      blocks <base> hijacking of every relative script URL
//   object-src 'none'    kills a whole class of plugin-based injection
//   form-action 'self'   stops a injected form posting credentials off-site
//   frame-ancestors      stops clickjacking of the admin screens
const CSP = [
  "default-src 'self'",
  // checkout.razorpay.com is injected by common.js at payment time.
  "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  // data: is required — greeting audio is played from a base64 data URL.
  "media-src 'self' data: blob:",
  "connect-src 'self' https://lumberjack.razorpay.com",
  "frame-src https://api.razorpay.com https://checkout.razorpay.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function withSecurityHeaders(res, env, url) {
  const out = new Response(res.body, res);
  const h = out.headers;

  // API responses must never be cached by the browser, by Cloudflare's edge,
  // or by any proxy in between.
  //
  // This was a real bug, not a precaution: /api/auth/me answers "who am I"
  // and had no cache headers at all, so a cache could store one visitor's
  // {"authenticated":true,...} and hand it to somebody else — and could serve
  // a stale {"authenticated":false} to someone who had just signed in
  // successfully, making a working login look broken.
  //
  // Vary: Cookie is the half that keeps a shared cache from mixing sessions;
  // no-store is the half that stops it being stored at all.
  //
  // Responses that deliberately set their own cache-control are left alone —
  // notably GET /api/reflections/:id/image, which Meta fetches when sending
  // the daily WhatsApp template and which must stay publicly cacheable.
  if (url.pathname.startsWith("/api/") && !h.has("cache-control")) {
    h.set("cache-control", "private, no-store, max-age=0, must-revalidate");
  }
  if (url.pathname.startsWith("/api/") && !h.has("vary")) {
    h.set("vary", "Cookie");
  }

  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("x-frame-options", "DENY");
  h.set("cross-origin-opener-policy", "same-origin");
  // microphone=(self), NOT () — the chat widget uses getUserMedia for voice
  // mode, and a blanket deny would silently break it.
  h.set(
    "permissions-policy",
    "geolocation=(), camera=(), payment=(), browsing-topics=(), microphone=(self)"
  );

  // HSTS only over real HTTPS; sending it from http://localhost would pin the
  // dev host to https and make local development unreachable.
  if (url.protocol === "https:") {
    h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }

  // CSP on documents only. Applying it to JSON/images buys nothing and risks
  // breaking the media the chat widget plays.
  const type = h.get("content-type") || "";
  if (type.includes("text/html")) h.set("content-security-policy", CSP);

  return out;
}

// Small local helper — b64url -> bytes, for decoding the Google ID token body.
function b64urlDecodeBytes(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Compact live snapshot of registrations + expenses for the agent to reason over.
async function buildDataSummary(env) {
  const registrations = await loadList(env, "registrations");
  const expenses = await loadList(env, "expenses");
  const money = (n) => "\u20b9" + Number(n || 0).toLocaleString("en-IN");

  const paid = registrations.filter((r) => r.paid);
  const totalPledged = registrations.reduce((s, r) => s + (r.amount || 0), 0);
  const totalCollected = paid.reduce((s, r) => s + (r.amount || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);

  const byCat = PRICING.map((c) => {
    const items = registrations.filter((r) => r.categoryId === c.id);
    return `${c.name}: ${items.length} registered (${money(
      items.reduce((s, r) => s + (r.amount || 0), 0)
    )})`;
  }).join("; ");

  const expGroups = {};
  for (const e of expenses) {
    const k = e.category || "General";
    expGroups[k] = (expGroups[k] || 0) + (e.amount || 0);
  }
  const expLines = Object.entries(expGroups)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${money(v)}`)
    .join("; ");

  return [
    "== LIVE EVENT DATA (authoritative, use these exact numbers) ==",
    `Total registrations: ${registrations.length} (paid/confirmed: ${paid.length}, pending payment: ${
      registrations.length - paid.length
    }).`,
    `By category -> ${byCat || "none yet"}.`,
    `Money pledged: ${money(totalPledged)}; collected: ${money(
      totalCollected
    )}; still to collect: ${money(totalPledged - totalCollected)}.`,
    `Total expenses: ${money(totalExpenses)} across ${expenses.length} item(s). By category -> ${
      expLines || "none yet"
    }.`,
    `Current balance (collected - expenses): ${money(totalCollected - totalExpenses)}.`,
  ].join("\n");
}

// ---- Ops dashboard email (daily digest + critical alerts) ------------------
async function getUsage(env, dateStr) {
  return (await env.CONVENTION_KV.get(usageKey(dateStr), { type: "json" })) || {};
}

// Deepgram: dollars remaining on the account (documented balances API).
// NOTE: reading balances needs a key with Owner/Administrator scope; a
// speak-only key gets 403 here even though TTS itself works fine. Set
// DEEPGRAM_BALANCE_KEY to a scoped key to enable this row without widening
// the main TTS key's permissions.
async function getDeepgramBalance(env) {
  const bKey = env.DEEPGRAM_BALANCE_KEY || env.DEEPGRAM_API_KEY;
  if (!bKey) return { ok: false, note: "no DEEPGRAM_API_KEY" };
  const permissionNote =
    "TTS works, but this key can't read the balance (403). Create a key with " +
    "Owner/Administrator scope in the Deepgram console and set it as DEEPGRAM_BALANCE_KEY.";
  try {
    const headers = { Authorization: "Token " + bKey };
    const pr = await fetch("https://api.deepgram.com/v1/projects", { headers });
    if (pr.status === 403) return { ok: false, permission: true, note: permissionNote };
    if (!pr.ok) return { ok: false, note: "projects http " + pr.status };
    const pd = await pr.json().catch(() => ({}));
    const id = pd.projects && pd.projects[0] && pd.projects[0].project_id;
    if (!id) return { ok: false, note: "no project on account" };
    const br = await fetch(`https://api.deepgram.com/v1/projects/${id}/balances`, { headers });
    if (br.status === 403) return { ok: false, permission: true, note: permissionNote };
    if (!br.ok) return { ok: false, note: "balances http " + br.status };
    const bd = await br.json().catch(() => ({}));
    const dollars = (bd.balances || []).reduce((s, b) => s + (Number(b.amount) || 0), 0);
    return { ok: true, dollars };
  } catch (e) {
    return { ok: false, note: e && e.message ? e.message : String(e) };
  }
}

// Cloudflare Workers request stats for the last 24h via the GraphQL API.
// Optional: needs CF_ACCOUNT_ID (var) + CF_API_TOKEN (secret, Analytics:Read).
async function getCloudflareRequests(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID)
    return { ok: false, note: "set CF_ACCOUNT_ID var + CF_API_TOKEN secret to enable" };
  try {
    // Window = the current UTC day, because that's how the free-plan daily
    // quota (100k requests) resets.
    const end = new Date();
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    const query =
      "query($tag: String!, $start: Time!, $end: Time!) { viewer { accounts(filter: {accountTag: $tag}) { " +
      "workersInvocationsAdaptive(filter: {datetime_geq: $start, datetime_leq: $end}, limit: 100) { sum { requests errors subrequests } } } } }";
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { tag: env.CF_ACCOUNT_ID, start: start.toISOString(), end: end.toISOString() },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.errors && data.errors.length)
      return { ok: false, note: data.errors[0].message || "graphql error" };
    const rows =
      (data.data &&
        data.data.viewer &&
        data.data.viewer.accounts &&
        data.data.viewer.accounts[0] &&
        data.data.viewer.accounts[0].workersInvocationsAdaptive) ||
      [];
    let requests = 0, errors = 0, subrequests = 0;
    for (const r of rows) {
      requests += (r.sum && r.sum.requests) || 0;
      errors += (r.sum && r.sum.errors) || 0;
      subrequests += (r.sum && r.sum.subrequests) || 0;
    }
    return { ok: true, requests, errors, subrequests };
  } catch (e) {
    return { ok: false, note: e && e.message ? e.message : String(e) };
  }
}

// Workers AI neurons used today (free plan: 10,000/day). The GraphQL field
// name has varied across schema versions, so try the known spellings and
// degrade gracefully to the self-tracked call count if none works.
async function getWorkersAiNeurons(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID)
    return { ok: false, note: "needs CF_API_TOKEN + CF_ACCOUNT_ID" };
  const end = new Date();
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  for (const field of ["totalNeurons", "neurons"]) {
    try {
      const query =
        "query($tag: String!, $start: Time!) { viewer { accounts(filter: {accountTag: $tag}) { " +
        "aiInferenceAdaptiveGroups(filter: {datetime_geq: $start}, limit: 100) { sum { " + field + " } } } } }";
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { tag: env.CF_ACCOUNT_ID, start: start.toISOString() } }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.errors && data.errors.length) continue; // wrong field name — try the next
      const rows =
        (data.data &&
          data.data.viewer &&
          data.data.viewer.accounts &&
          data.data.viewer.accounts[0] &&
          data.data.viewer.accounts[0].aiInferenceAdaptiveGroups) ||
        [];
      let neurons = 0;
      for (const r of rows) neurons += (r.sum && r.sum[field]) || 0;
      return { ok: true, neurons };
    } catch (e) {
      /* try next field */
    }
  }
  return { ok: false, note: "AI analytics not available on this account/token" };
}

// ---------------------------------------------------------------------------
// MASCOT EMAIL KIT — the full chat-button robot in email-safe boxes, inside
// the gradient-banner shell (Shell B) with the site logo.
function emailMascot(mood) {
  // The FULL robot, drawn with plain stacked boxes so it survives real email
  // clients (Gmail strips <style>, keyframes, position:absolute AND inline
  // SVG): antenna, head with eyes/mouth (tears when sad), gradient body,
  // arms in the side columns, little legs. Static pose per mood.
  const M =
    {
      dance: { mouth: "smile", armL: "up", armR: "up", confetti: true },
      happy: { mouth: "smile", armL: "down", armR: "down" },
      wave: { mouth: "smile", armL: "down", armR: "up" },
      sad: { mouth: "frown", armL: "low", armR: "low", tears: true, droop: true },
      worried: { mouth: "oh", armL: "mid", armR: "mid", sweat: true },
    }[mood] || { mouth: "smile", armL: "down", armR: "down" };

  const ink = "#312e81";
  const headBg = "#dbe3fd";
  const edge = "#a5b4fc";

  const mouth =
    M.mouth === "frown"
      ? "width:18px;height:8px;border-radius:18px 18px 0 0;"
      : M.mouth === "oh"
      ? "width:9px;height:9px;border-radius:9px;"
      : "width:18px;height:8px;border-radius:0 0 18px 18px;";

  // Sad eyes are heavy half-moons; normal eyes are round.
  const eyeStyle = M.tears
    ? "display:inline-block;width:11px;height:6px;border-radius:0 0 11px 11px;background:" +
      ink +
      ";margin:3px 8px 0"
    : "display:inline-block;width:10px;height:10px;border-radius:10px;background:" + ink + ";margin:0 8px";
  const eye = '<span style="' + eyeStyle + '"></span>';
  const tear =
    '<span style="display:inline-block;width:6px;height:10px;border-radius:6px 6px 7px 7px;background:#38bdf8;margin:0 14px"></span>';

  const armTop = { up: 6, mid: 44, down: 58, low: 66 };
  const arm = (p) =>
    '<div style="width:8px;height:26px;border-radius:6px;background:#ffffff;border:2px solid ' +
    edge +
    ";margin-top:" +
    armTop[p] +
    'px"></div>';
  const leg =
    '<span style="display:inline-block;width:9px;height:14px;border-radius:5px;background:' +
    ink +
    ';margin:0 7px"></span>';

  // Sad: the antenna ball slumps to the side instead of sitting proud.
  const antenna = M.droop
    ? '<div style="width:9px;height:9px;border-radius:9px;background:' + edge + ';margin:0 auto 0 22px"></div>' +
      '<div style="width:3px;height:7px;background:' + edge + ';margin:-2px auto 2px 30px"></div>'
    : '<div style="width:9px;height:9px;border-radius:9px;background:#7c3aed;margin:0 auto"></div>' +
      '<div style="width:3px;height:7px;background:' + edge + ';margin:0 auto 2px"></div>';

  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;width:auto"><tr>' +
    '<td style="vertical-align:top;padding-right:4px">' +
    (M.confetti ? '<div style="font-size:16px;line-height:1;margin:0 0 2px">🎉</div>' : "") +
    arm(M.armL) +
    "</td>" +
    "<td>" +
    antenna +
    '<div style="width:80px;height:58px;border-radius:18px;background:' +
    headBg +
    ";background-image:linear-gradient(160deg,#eef2ff," +
    headBg +
    ");border:2px solid " +
    edge +
    '">' +
    '<div style="padding-top:14px;text-align:center;line-height:0">' +
    eye +
    eye +
    "</div>" +
    (M.tears
      ? '<div style="text-align:center;line-height:0;margin-top:3px">' + tear + tear + "</div>"
      : "") +
    '<div style="margin:' +
    (M.tears ? 3 : 9) +
    "px auto 0;background:" +
    ink +
    ";" +
    mouth +
    '"></div>' +
    "</div>" +
    '<div style="width:56px;height:26px;border-radius:10px 10px 8px 8px;background-color:#5b5bf0;background-image:linear-gradient(160deg,#5b5bf0,#7c3aed);margin:3px auto 0"></div>' +
    '<div style="text-align:center;line-height:0;margin-top:2px">' +
    leg +
    leg +
    "</div>" +
    "</td>" +
    '<td style="vertical-align:top;padding-left:4px">' +
    (M.confetti ? '<div style="font-size:16px;line-height:1;margin:0 0 2px">✨</div>' : "") +
    (M.sweat
      ? '<div style="width:6px;height:10px;border-radius:6px 6px 7px 7px;background:#38bdf8;margin:0 0 2px 2px"></div>'
      : "") +
    arm(M.armR) +
    "</td>" +
    "</tr></table>"
  );
}

// Absolute URL for the little logo PNG in email headers (email clients need a
// full URL; the PNG lives in public/img/, rendered from favicon.svg).
function emailLogoUrl(env) {
  const origin = (env && (env.SITE_ORIGIN || env.AUTH_ORIGIN)) || "https://biaac.com";
  return origin.replace(/\/+$/, "") + "/img/email-logo.png";
}

// Shared shell for every mail the site sends a person: gradient banner with
// the logo + wordmark, the full robot mascot popping over the banner edge in
// the mood that fits the news, then the words.
function mascotEmail({ mood = "happy", title, intro, bodyHtml = "", button, note, logo = "" }) {
  const btn = button
    ? '<p style="margin:24px 0 6px;text-align:center"><a href="' +
      button.href +
      '" style="background:#4f46e5;color:#ffffff;padding:13px 28px;border-radius:12px;text-decoration:none;font-weight:600;display:inline-block">' +
      button.label +
      "</a></p>"
    : "";
  return (
    '<div style="background:#eef1fb;padding:34px 12px">' +
    '<div style="max-width:520px;margin:0 auto;border-radius:20px;overflow:hidden;border:1px solid #e2e6f8;background:#ffffff;font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,sans-serif;color:#1f2937">' +
    '<div style="background-color:#5b5bf0;background-image:linear-gradient(120deg,#38bdf8,#5b5bf0 55%,#7c3aed);padding:18px 24px 46px;text-align:center">' +
    (logo
      ? '<img src="' +
        logo +
        '" width="38" height="38" alt="" style="display:inline-block;vertical-align:middle;border-radius:11px">'
      : "") +
    '<span style="color:#ffffff;font-weight:700;font-size:15px;letter-spacing:0.3px;margin-left:10px;vertical-align:middle">Bangalore Convention 2027</span>' +
    "</div>" +
    '<div style="margin-top:-34px">' +
    emailMascot(mood) +
    "</div>" +
    '<div style="padding:6px 30px 26px">' +
    '<h2 style="margin:14px 0 10px;text-align:center;color:#111827;font-size:20px">' +
    title +
    "</h2>" +
    '<p style="color:#4b5563;line-height:1.65;text-align:center;margin:0">' +
    intro +
    "</p>" +
    bodyHtml +
    btn +
    (note
      ? '<p style="color:#8a91a8;font-size:13px;line-height:1.6;margin:18px 0 0;text-align:center">' +
        note +
        "</p>"
      : "") +
    "</div></div>" +
    '<p style="max-width:520px;margin:14px auto 0;text-align:center;color:#9aa1b9;font-size:12px;font-family:system-ui,sans-serif">Bangalore Convention 2027 · delivered by the site\'s little mascot 🤖</p>' +
    "</div>"
  );
}

// When something security-relevant happens, say when it happened in the
// reader's own clock (event times on this site are IST).
function istClock() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---- Registration confirmation email --------------------------------------
// The email twin of the WhatsApp receipt: C's celebration on top, and the
// SAME ticket the register wizard renders on-site — same per-category icon
// and gradient (keyed by the category's index in PRICING, the same order
// register.html reads from /api/pricing), same BC- reference, same stub.
const TICKET_ICONS = ["🛏️", "🚪", "👥", "👨‍👩‍👦", "🎟️", "⭐"];
const TICKET_GRADS = [
  ["#f59e0b", "#ef4444"],
  ["#38bdf8", "#5b5bf0"],
  ["#a78bfa", "#7c3aed"],
  ["#34d399", "#0ea5e9"],
  ["#fb7185", "#f59e0b"],
];

function registrationEmail(env, reg, paid) {
  const idx = Math.max(0, PRICING.findIndex((c) => c.id === reg.categoryId));
  const icon = TICKET_ICONS[idx % TICKET_ICONS.length];
  const grad = TICKET_GRADS[idx % TICKET_GRADS.length];
  const ref = "BC-" + String(reg.id || "").slice(0, 8).toUpperCase();
  const first = esc(String(reg.name || "friend").trim().split(/\s+/)[0]);
  const amount = "₹" + Number(reg.amount || 0).toLocaleString("en-IN");

  const pill = paid
    ? '<span style="background:#d9f4e6;color:#0b7a43;padding:3px 11px;border-radius:999px;font-weight:800;font-size:12px">✓ PAID</span>'
    : '<span style="background:#fdf0d4;color:#8a6207;padding:3px 11px;border-radius:999px;font-weight:800;font-size:12px">⏳ PENDING</span>';
  const payNote = paid
    ? "Payment received, spot reserved, nothing left to do — just count the days with us."
    : "You can pay online any time or hand it to the team at the venue — zero stress either way. Your spot is saved.";
  // Deterministic decorative barcode, same formula as the wizard's stub bars.
  const bars = Array.from(
    { length: 26 },
    (_, i) =>
      '<span style="display:inline-block;width:3px;height:' +
      (8 + ((i * 7) % 14)) +
      'px;background:#1f2937;margin:0 1px;vertical-align:bottom"></span>'
  ).join("");

  // Mobile-first: everything centred and stacked, so a 320px Gmail viewport
  // renders the same shapes as desktop — nothing competes for width. The
  // category band is a full-width TOP strip (like a real event ticket) and
  // the status pill sits on its own line so it can never wrap mid-sentence.
  const inner =
    '<div style="text-align:center;font-size:19px;letter-spacing:4px;margin-top:10px">🎊 🎉 🎊</div>' +
    '<h2 style="margin:6px 0 4px;text-align:center;font-size:23px;font-weight:900;' +
    "background:linear-gradient(90deg,#10b981,#5b5bf0,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent\">" +
    (paid ? "LET'S GOOOO — PAID &amp; IN!!" : "LET'S GOOOO — YOU'RE IN!!") +
    "</h2>" +
    '<p style="color:#4b5563;text-align:center;margin:0 0 16px;line-height:1.65">' +
    "You did it, " + first + "!! The mascot printed your ticket itself and is extremely proud of the perforation.</p>" +
    // ---- the ticket (mirror of the wizard's, stacked for phones) ----
    '<div style="border:2px solid #c7d2fe;border-radius:16px;overflow:hidden">' +
    '<div style="background-color:' + grad[0] +
    ";background-image:linear-gradient(120deg," + grad[0] + "," + grad[1] +
    ');padding:9px 12px;text-align:center;font-size:22px;line-height:1">' + icon + "</div>" +
    '<div style="padding:13px 14px 14px;text-align:center">' +
    '<div style="font-size:10.5px;letter-spacing:0.8px;color:#6b7280;font-weight:700">BANGALORE CONVENTION · 9–11 JULY 2027</div>' +
    '<div style="font-size:20px;font-weight:800;margin:4px 0 2px;color:#111827">' + esc(reg.name || "") + "</div>" +
    '<div style="font-size:13.5px;color:#4b5563">' + esc(reg.categoryName || "") + " · " + amount + "</div>" +
    '<div style="margin-top:8px">' + pill + "</div>" +
    "</div>" +
    '<div style="border-top:2px dashed #c7d2fe;padding:10px 12px;text-align:center;background:#f8f9ff">' +
    '<span style="font-family:ui-monospace,Consolas,monospace;font-weight:800;font-size:16px;letter-spacing:2px;color:#111827">' + ref + "</span><br>" +
    '<span style="line-height:0">' + bars + "</span></div></div>" +
    '<p style="color:#8a91a8;font-size:12.5px;text-align:center;margin:14px 0 0;line-height:1.6">' +
    "Keep this email — flash the reference at the door and you're in. " + payNote + "</p>";

  const html =
    '<div style="background:#eef1fb;padding:22px 8px">' +
    '<div style="max-width:520px;margin:0 auto;border-radius:20px;overflow:hidden;border:1px solid #e2e6f8;background:#ffffff;font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,sans-serif;color:#1f2937">' +
    '<div style="background-color:#5b5bf0;background-image:linear-gradient(120deg,#38bdf8,#5b5bf0 55%,#7c3aed);padding:14px 16px 42px;text-align:center">' +
    '<img src="' + emailLogoUrl(env) + '" width="34" height="34" alt="" style="display:inline-block;vertical-align:middle;border-radius:10px">' +
    '<span style="color:#ffffff;font-weight:700;font-size:14.5px;margin-left:9px;vertical-align:middle">Bangalore Convention 2027</span></div>' +
    '<div style="margin-top:-32px">' + emailMascot("dance") + "</div>" +
    '<div style="padding:4px 16px 22px">' + inner + "</div></div>" +
    '<p style="max-width:520px;margin:12px auto 0;text-align:center;color:#9aa1b9;font-size:11.5px;font-family:system-ui,sans-serif">Bangalore Convention 2027 · delivered by the site\'s little mascot 🤖<br>9–11 July 2027 · Bangalore, India</p>' +
    "</div>";

  const subject = paid
    ? "LET'S GOOOO — you're in AND paid!! 🎉 (" + ref + ")"
    : "LET'S GOOOO — you're in!! 🎉 (" + ref + ")";
  return { subject, html };
}

// Fire-and-forget, like the WhatsApp receipt: a mail hiccup must never break
// a registration or a payment. The recipient is the STORED record's email.
function sendRegistrationEmail(env, ctx, reg, paid) {
  if (!reg || !reg.email) return;
  try {
    const mail = registrationEmail(env, reg, paid);
    const work = sendMail(env, reg.email, mail.subject, mail.html, { toName: reg.name || "" });
    if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  } catch (e) {
    console.log("registration email failed to build:", e && e.message);
  }
}

// General mail sender. Magic links need to reach an arbitrary staff address,
// so the recipient is a parameter — but see handleAuth: that address always
// comes from a database row, never from a request body, which is what stops
// this becoming the open relay that POST /api/contact currently is.
async function sendMail(env, to, subject, html, opts = {}) {
  if (!to) return { ok: false, note: "no recipient" };
  try {
    const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.MAILCHANNELS_API_KEY || "" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to, name: opts.toName || "" }] }],
        from: { email: "noreply@biaac.com", name: opts.fromName || "Bangalore Convention" },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
    });
    return { ok: res.ok || res.status === 202, note: "http " + res.status };
  } catch (e) {
    return { ok: false, note: e && e.message ? e.message : String(e) };
  }
}

async function sendOpsEmail(env, subject, html) {
  if (!env.DASHBOARD_EMAIL) return { ok: false, note: "DASHBOARD_EMAIL not set" };
  return sendMail(env, env.DASHBOARD_EMAIL, subject, html, {
    toName: "Convention Ops",
    fromName: "Convention Ops Dashboard",
  });
}

// Everything the dashboard shows, gathered in one place.
async function collectDashboardData(env) {
  const today = istDate(0);
  const yesterday = istDate(1);
  const [usageToday, usageYesterday, dg, cf, ai, registrations, expenses, groqLimits] = await Promise.all([
    getUsage(env, today),
    getUsage(env, yesterday),
    getDeepgramBalance(env),
    getCloudflareRequests(env),
    getWorkersAiNeurons(env),
    loadList(env, "registrations"),
    loadList(env, "expenses"),
    env.CONVENTION_KV.get("groq:limits", { type: "json" }),
  ]);
  const paid = registrations.filter((r) => r.paid);
  const collected = paid.reduce((s, r) => s + (r.amount || 0), 0);
  const spent = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const d = {
    today, yesterday, usageToday, usageYesterday, dg, cf, ai, groqLimits,
    regs: {
      count: registrations.length,
      paidCount: paid.length,
      collected,
      expenses: spent,
      balance: collected - spent,
    },
  };
  d.allowances = buildAllowances(d, env);
  return d;
}

// Critical conditions worth an immediate email. Each has a stable id so the
// 6-hourly check never sends the same alert twice in a day.
function findAlerts(d, env) {
  const alerts = [];
  const minDollars = Number(env.ALERT_DEEPGRAM_MIN || 2);
  if (d.dg.ok && d.dg.dollars < minDollars) {
    alerts.push({
      id: "deepgram-low",
      text: `Deepgram balance is $${d.dg.dollars.toFixed(2)} — below the $${minDollars} threshold. The neural voice stops working at $0; top up soon.`,
    });
  }
  // A 403 is a key-scope issue, not an outage — TTS still works, so it stays
  // an informational note in the digest rather than a critical alert.
  if (!d.dg.ok && !d.dg.permission && env.DEEPGRAM_API_KEY) {
    alerts.push({
      id: "deepgram-error",
      text: `Deepgram API is not answering for the configured key (${d.dg.note}). The key may be expired or revoked — voice replies are falling back to the robotic browser voice.`,
    });
  }
  if ((d.usageToday.degradedReplies || 0) >= 5) {
    alerts.push({
      id: "chat-degraded",
      text: `${d.usageToday.degradedReplies} chat requests today ended in the "assistant is resting" fallback — ALL AI providers (Workers AI, Gemini, Groq) are failing. Check keys and quotas.`,
    });
  }
  if (
    d.groqLimits &&
    d.groqLimits.requestsLimit &&
    d.groqLimits.requestsRemaining !== null &&
    d.groqLimits.requestsRemaining < d.groqLimits.requestsLimit * 0.1
  ) {
    alerts.push({
      id: "groq-quota-low",
      text: `Groq has only ${d.groqLimits.requestsRemaining} of ${d.groqLimits.requestsLimit} daily requests left — when it hits 0 the chat loses its most reliable fallback provider until the daily reset.`,
    });
  }
  if (d.cf.ok && d.cf.requests > 90000) {
    alerts.push({
      id: "cf-requests-high",
      text: `${d.cf.requests.toLocaleString()} Worker requests today — the free plan allows 100,000/day. The site may start rejecting requests.`,
    });
  }
  if (d.ai.ok && d.ai.neurons >= FREE_LIMITS.aiNeurons * 0.9) {
    alerts.push({
      id: "workers-ai-neurons-high",
      text: `Workers AI has used ${Math.round(d.ai.neurons).toLocaleString()} of 10,000 free neurons today (${Math.round((d.ai.neurons / FREE_LIMITS.aiNeurons) * 100)}%). When it hits the cap, chat replies shift to the Groq/Gemini fallbacks until the daily reset.`,
    });
  }
  const kvEst = (d.usageToday.chatRequests || 0) + (d.usageToday.ttsCalls || 0) + (d.usageToday.groqCalls || 0);
  if (kvEst >= FREE_LIMITS.kvWrites * 0.9) {
    alerts.push({
      id: "kv-writes-high",
      text: `≈${kvEst} KV writes today of the 1,000/day free allowance — registrations and payment updates may start failing. Consider the $5 Workers Paid plan if this recurs.`,
    });
  }
  return alerts;
}

const money = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");

// Human note for the Groq row: real remaining quota from Groq's own
// rate-limit headers, captured on the most recent Groq call.
function groqQuotaNote(gl) {
  if (!gl) return "quota appears after the first Groq call";
  const parts = [];
  if (gl.requestsRemaining !== null && gl.requestsLimit) {
    parts.push(gl.requestsRemaining.toLocaleString() + " of " + gl.requestsLimit.toLocaleString() + " requests left today");
  }
  if (gl.tokensRemaining !== null) {
    parts.push(gl.tokensRemaining.toLocaleString() + " tokens/min free");
  }
  const when = gl.at ? " (as of " + gl.at.slice(11, 16) + " UTC)" : "";
  return parts.length ? parts.join(" · ") + when : "quota headers unavailable";
}

// ---- Free-allowance meter: the chart at the top of the digest --------------
// Every quota that could silently exhaust and force a paid plan, as a percent.
const FREE_LIMITS = { workersRequests: 100000, aiNeurons: 10000, kvWrites: 1000 };

function buildAllowances(d, env) {
  const u = d.usageToday;
  const bars = [];
  bars.push({
    label: "Cloudflare Workers requests",
    pct: d.cf.ok ? (d.cf.requests / FREE_LIMITS.workersRequests) * 100 : null,
    detail: d.cf.ok
      ? d.cf.requests.toLocaleString() + " of 100,000 free requests today (UTC day)"
      : d.cf.note,
  });
  bars.push({
    label: "Workers AI neurons",
    pct: d.ai.ok ? (d.ai.neurons / FREE_LIMITS.aiNeurons) * 100 : null,
    detail: d.ai.ok
      ? Math.round(d.ai.neurons).toLocaleString() + " of 10,000 free neurons today"
      : d.ai.note + " — " + (u.workersAiWins || 0) + " Workers AI replies self-tracked today",
  });
  const gl = d.groqLimits;
  if (gl && gl.requestsLimit && gl.requestsRemaining !== null) {
    const used = gl.requestsLimit - gl.requestsRemaining;
    bars.push({
      label: "Groq daily requests",
      pct: (used / gl.requestsLimit) * 100,
      detail: used.toLocaleString() + " of " + gl.requestsLimit.toLocaleString() + " used (from Groq's own headers)",
    });
  } else {
    bars.push({ label: "Groq daily requests", pct: null, detail: "quota appears after the first Groq call" });
  }
  const credit = Number(env.DEEPGRAM_CREDIT_TOTAL || 200);
  bars.push({
    label: "Deepgram free credit",
    pct: d.dg.ok && credit > 0 ? ((credit - d.dg.dollars) / credit) * 100 : null,
    detail: d.dg.ok
      ? "$" + d.dg.dollars.toFixed(2) + " left of $" + credit + " (set DEEPGRAM_CREDIT_TOTAL if different)"
      : d.dg.note,
  });
  // Tracked events ≈ 1 KV write each; the free plan allows only 1,000/day and
  // this dashboard's own telemetry is part of that budget.
  const kvEst = (u.chatRequests || 0) + (u.ttsCalls || 0) + (u.groqCalls || 0);
  bars.push({
    label: "KV writes (estimate)",
    pct: (kvEst / FREE_LIMITS.kvWrites) * 100,
    detail: "≈" + kvEst + " of 1,000 free writes today — includes this dashboard's own tracking",
  });
  return bars;
}

function barColor(pct) {
  if (pct === null) return "#cbd5e1";
  if (pct >= 90) return "#ef4444";
  if (pct >= 70) return "#f59e0b";
  return "#22c55e";
}

function allowanceChartHtml(bars) {
  const rows = bars
    .map((b) => {
      const pct = b.pct === null ? null : Math.min(100, Math.max(0, b.pct));
      const col = barColor(pct);
      const pctLabel =
        pct === null ? "n/a" : b.pct >= 100 ? "100%+" : pct.toFixed(pct < 10 ? 1 : 0) + "%";
      return (
        '<div style="margin:12px 0 0">' +
        '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">' +
        '<span style="color:#333">' + b.label + "</span>" +
        '<strong style="color:' + (pct !== null && pct >= 90 ? "#ef4444" : "#333") + '">' + pctLabel + "</strong></div>" +
        '<div style="background:#e2e8f0;border-radius:6px;height:10px;overflow:hidden">' +
        '<div style="width:' + (pct === null ? 100 : Math.max(2, pct)) + "%;height:10px;border-radius:6px;background:" + col + '"></div></div>' +
        '<div style="font-size:11px;color:#94a3b8;margin-top:3px">' + b.detail + "</div>" +
        "</div>"
      );
    })
    .join("");
  return (
    '<div style="background:#fff;border:1px solid #eee;border-radius:8px;padding:14px 16px;margin:0 0 18px">' +
    '<strong style="font-size:14px;color:#333">📈 Free allowance used</strong>' +
    rows +
    "</div>"
  );
}

function dashRow(label, value, note) {
  return (
    '<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555">' + label +
    '</td><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;text-align:right">' + value +
    '</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#999;font-size:12px">' + (note || "") +
    "</td></tr>"
  );
}

function dashSection(title, rowsHtml) {
  return (
    '<h3 style="margin:22px 0 6px;font-size:14px;color:#333">' + title + "</h3>" +
    '<table style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #eee;border-radius:8px">' +
    rowsHtml + "</table>"
  );
}

function buildDigestHtml(d, alerts) {
  const u = d.usageToday, y = d.usageYesterday;
  const cmp = (a, b) => `${a || 0} <span style="color:#999;font-weight:400">(yday ${b || 0})</span>`;
  const models = Object.entries(u.models || {})
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => dashRow(m, n, ""))
    .join("") || dashRow("no chat replies yet today", "-", "");
  // Deepgram Aura-2 list price ≈ $0.030 per 1k characters.
  const ttsCost = ((u.ttsChars || 0) / 1000) * 0.03;

  const alertHtml = alerts.length
    ? '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin:0 0 18px">' +
      '<strong style="color:#b91c1c">⚠️ Needs attention</strong><ul style="margin:8px 0 0;padding-left:18px;color:#7f1d1d">' +
      alerts.map((a) => "<li>" + a.text + "</li>").join("") + "</ul></div>"
    : '<p style="color:#15803d;margin:0 0 18px">✅ All systems healthy.</p>';

  return (
    '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#f8fafc">' +
    '<h2 style="margin:0 0 4px">📊 Convention dashboard — ' + d.today + "</h2>" +
    '<p style="color:#777;margin:0 0 18px">Daily ops digest for the Bangalore Convention site.</p>' +
    allowanceChartHtml(d.allowances) +
    alertHtml +
    dashSection("💰 Balances & platform",
      dashRow("Deepgram credit remaining", d.dg.ok ? "$" + d.dg.dollars.toFixed(2) : "unavailable", d.dg.ok ? "TTS voice budget" : d.dg.note) +
      dashRow("Cloudflare requests (today, UTC)", d.cf.ok ? d.cf.requests.toLocaleString() : "n/a", d.cf.ok ? d.cf.errors + " errors · " + d.cf.subrequests.toLocaleString() + " subrequests" : d.cf.note)
    ) +
    dashSection("🤖 AI usage today",
      dashRow("Chat requests", cmp(u.chatRequests, y.chatRequests), (u.voiceChats || 0) + " via voice") +
      dashRow("Workers AI replies", cmp(u.workersAiWins, y.workersAiWins), "free tier: 10k neurons/day") +
      dashRow("Groq replies", cmp(u.groqCalls, y.groqCalls), groqQuotaNote(d.groqLimits)) +
      dashRow("Failed completely (degraded)", cmp(u.degradedReplies, y.degradedReplies), "“assistant is resting” shown")
    ) +
    dashSection("🗣️ Text-to-speech today",
      dashRow("TTS clips", cmp(u.ttsCalls, y.ttsCalls), (u.melo || 0) + " fell back to MeloTTS") +
      dashRow("Characters synthesized", cmp(u.ttsChars, y.ttsChars), "≈ $" + ttsCost.toFixed(3) + " at Aura-2 list price")
    ) +
    dashSection("🎯 Models that answered today", models) +
    dashSection("🎟️ Event numbers",
      dashRow("Registrations", d.regs.count, d.regs.paidCount + " paid") +
      dashRow("Collected", money(d.regs.collected), "") +
      dashRow("Expenses", money(d.regs.expenses), "") +
      dashRow("Balance", money(d.regs.balance), "")
    ) +
    '<p style="color:#aaa;font-size:11px;margin-top:20px">Sent automatically by the Convention Worker · daily digest</p>' +
    "</div>"
  );
}

function buildAlertHtml(alerts) {
  return (
    '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px">' +
    '<h2 style="color:#b91c1c;margin:0 0 12px">🚨 Convention site — critical alert</h2>' +
    '<ul style="padding-left:18px;color:#333;line-height:1.6">' +
    alerts.map((a) => "<li>" + a.text + "</li>").join("") +
    "</ul>" +
    '<p style="color:#777">The daily digest has full numbers. This alert is sent at most once per issue per day.</p>' +
    "</div>"
  );
}

async function runDailyDigest(env) {
  const d = await collectDashboardData(env);
  const alerts = findAlerts(d, env);
  const subject = (alerts.length ? "⚠️ " : "📊 ") + "Convention daily dashboard — " + d.today;
  const result = await sendOpsEmail(env, subject, buildDigestHtml(d, alerts));
  // Remember the outcome so /api/report/status can answer "did it send?".
  await env.CONVENTION_KV.put(
    "report:lastDigest",
    JSON.stringify({ at: new Date().toISOString(), ok: !!result.ok, note: result.note || "", subject }),
    { expirationTtl: 60 * 60 * 24 * 14 }
  );
  return result;
}

// The single 10-minute cron lands here. The digest goes out on the first tick
// at/after the configured IST time (once per IST day); the critical check runs
// every ~6 hours. Digest time: KV override (set via /api/report/schedule,
// no redeploy needed) → DIGEST_TIME_IST var → 09:00.
async function getDigestTime(env) {
  const saved = await env.CONVENTION_KV.get("settings:digestTime");
  const t = saved || env.DIGEST_TIME_IST || "09:00";
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : "09:00";
}

async function runSchedules(env) {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000); // IST = UTC+5:30
  const today = ist.toISOString().slice(0, 10);
  const hhmm = ist.toISOString().slice(11, 16);
  const digestAt = await getDigestTime(env);
  if (hhmm >= digestAt && !(await env.CONVENTION_KV.get("digest:sent:" + today))) {
    const result = await runDailyDigest(env);
    // Mark the day done only when the email actually went out — a transient
    // mail failure retries on the next 10-minute tick instead of losing the day.
    if (result && result.ok) {
      await env.CONVENTION_KV.put("digest:sent:" + today, "1", { expirationTtl: 60 * 60 * 48 });
    }
  }
  // Daily reflection broadcast, same shape as the digest: fires on the first
  // tick at/after the configured IST time, once per IST day. Stays completely
  // inert until REFLECTION_RECIPIENTS is set.
  const reflectAt = /^([01]\d|2[0-3]):[0-5]\d$/.test(env.REFLECTION_TIME_IST || "")
    ? env.REFLECTION_TIME_IST
    : "07:00";
  if (
    env.REFLECTION_RECIPIENTS &&
    hhmm >= reflectAt &&
    !(await env.CONVENTION_KV.get("reflection:sent:" + today))
  ) {
    const result = await runReflectionBroadcast(env);
    // Only mark the day done once something actually went out, so a transient
    // failure retries on the next tick instead of silently losing the day.
    if (result && result.ok) {
      await env.CONVENTION_KV.put("reflection:sent:" + today, "1", { expirationTtl: 60 * 60 * 48 });
    }
  }

  const last = Number(await env.CONVENTION_KV.get("critical:last")) || 0;
  if (Date.now() - last >= 6 * 3600 * 1000) {
    await env.CONVENTION_KV.put("critical:last", String(Date.now()), { expirationTtl: 60 * 60 * 48 });
    await runCriticalCheck(env);
  }

  await pruneAuthTables(env);
}

// Housekeeping on the existing 10-minute cron. Without this, every session
// row and every audit event lives forever in D1.
async function pruneAuthTables(env) {
  try {
    await ensureAuthTables(env);
    const now = Date.now();
    await env.CONVENTION_DB.batch([
      // Sessions are unusable once past their absolute expiry; keep a week's
      // grace so "where am I signed in" history is not cut off abruptly.
      env.CONVENTION_DB.prepare("DELETE FROM session WHERE absolute_exp < ?").bind(now - 7 * 86400000),
      env.CONVENTION_DB.prepare("DELETE FROM auth_event WHERE at < ?").bind(now - 180 * 86400000),
      env.CONVENTION_DB.prepare("DELETE FROM magic_token WHERE expires_at < ?").bind(now - 86400000),
      env.CONVENTION_DB.prepare("DELETE FROM oauth_tx WHERE expires_at < ?").bind(now - 86400000),
      env.CONVENTION_DB.prepare("DELETE FROM rate_limit WHERE reset_at < ?").bind(now - 86400000),
    ]);
  } catch (e) {
    console.log("pruneAuthTables failed:", e && e.message);
  }
}

async function runCriticalCheck(env) {
  const d = await collectDashboardData(env);
  const alerts = findAlerts(d, env);
  const fresh = [];
  for (const a of alerts) {
    const k = "alert:" + d.today + ":" + a.id;
    if (!(await env.CONVENTION_KV.get(k))) {
      fresh.push(a);
      await env.CONVENTION_KV.put(k, "1", { expirationTtl: 60 * 60 * 24 });
    }
  }
  if (!fresh.length) return { ok: true, note: "nothing critical (or already alerted today)" };
  const result = await sendOpsEmail(
    env,
    "🚨 Convention CRITICAL: " + fresh.map((f) => f.id).join(", "),
    buildAlertHtml(fresh)
  );
  await env.CONVENTION_KV.put(
    "report:lastCritical",
    JSON.stringify({ at: new Date().toISOString(), ok: !!result.ok, note: result.note || "", alerts: fresh.map((f) => f.id) }),
    { expirationTtl: 60 * 60 * 24 * 14 }
  );
  return result;
}

// ---- WhatsApp Cloud API ----------------------------------------------------
// Two-way TEXT only. Inbound messages are fed straight into the same /api/chat
// brain the website uses, so the persona, the D1 knowledge and the provider
// fallback chain all stay in exactly one place. Deepgram is deliberately not
// touched here - no voice notes, so the TTS credit is untouched by WhatsApp.
//
// Secrets (npx wrangler secret put NAME):
//   WHATSAPP_TOKEN         permanent system-user token from Business Settings
//   WHATSAPP_VERIFY_TOKEN  any random string; must match what Meta is given
//   WHATSAPP_APP_SECRET    app secret, used to reject forged webhook calls
// Plain var (safe to keep in wrangler.toml):
//   WHATSAPP_PHONE_ID      the "Phone number ID" from the API Setup page

const WA_GRAPH = "https://graph.facebook.com/v26.0";
const WA_HISTORY_TURNS = 6; // short on purpose: fewer prompt tokens = fewer neurons
const WA_DAILY_CAP = 40; // per sender, so nobody can drain the free tiers

// STOP opt-out, promised in public/privacy.html. Matched on the whole message
// with punctuation stripped, so "Stop." opts out but "please stop asking" does
// not - a false positive here silently cuts someone off from their own booking.
const WA_STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "OPTOUT", "CANCEL", "QUIT"]);
const WA_START_WORDS = new Set(["START", "UNSTOP", "RESUME", "SUBSCRIBE", "OPTIN"]);
// An opt-out has to outlive the 24h conversation record, or it would quietly
// expire and we would start messaging them again.
const WA_OPTOUT_TTL = 60 * 60 * 24 * 365;

// Digits-only E.164 is the only shape the Cloud API accepts:
// "+91 98765 43210" / "09876543210" / "9876543210" -> "919876543210".
function waNormalize(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return "91" + d;
  if (d.length === 11 && d[0] === "0") return "91" + d.slice(1);
  return d; // already carries a country code
}

async function waPost(env, payload) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID) {
    // Silent here would look exactly like "the bot ignored me".
    console.log(
      "whatsapp: NOT CONFIGURED - token:" + (env.WHATSAPP_TOKEN ? "set" : "MISSING") +
      " phoneId:" + (env.WHATSAPP_PHONE_ID ? "set" : "MISSING")
    );
    return null;
  }
  const res = await fetch(WA_GRAPH + "/" + env.WHATSAPP_PHONE_ID + "/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer " + env.WHATSAPP_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!res.ok) {
    console.log("whatsapp send failed:", res.status, await res.text().catch(() => ""));
  }
  return res;
}

const waSendText = (env, to, body) =>
  waPost(env, { to, type: "text", text: { preview_url: false, body: body.slice(0, 4096) } });

// The approved "registration_confirmed" utility template. The header image is
// served from our own public/ folder, so there is no media ID to keep alive.
async function waSendConfirmation(env, reg, origin) {
  const to = waNormalize(reg && reg.phone);
  if (!to) return null;

  // The privacy policy promises STOP covers every WhatsApp message we send, so
  // it applies to the transactional receipt too - not just the chatty ones.
  const state = await env.CONVENTION_KV.get("wa:" + to, { type: "json" });
  if (state && state.optedOut) {
    console.log("whatsapp: confirmation skipped, recipient opted out");
    return null;
  }

  return waPost(env, {
    to,
    type: "template",
    template: {
      // Full name per the template's detail page: "registration_confirmed",
      // language English (en). The Manager LIST truncates it to
      // "registration_conf" - do not trust the list column.
      name: "registration_confirmed",
      language: { code: env.WHATSAPP_TEMPLATE_LANG || "en" },
      components: [
        {
          type: "header",
          parameters: [
            { type: "image", image: { link: origin + "/img/registration-confirmed.png" } },
          ],
        },
        {
          type: "body",
          parameters: [
            { type: "text", text: reg.name || "there" },
            { type: "text", text: reg.categoryName || "Convention" },
            { type: "text", text: Number(reg.amount || 0).toLocaleString("en-IN") },
            { type: "text", text: reg.paymentId || reg.id || "-" },
          ],
        },
      ],
    },
  });
}

// WhatsApp template PARAMETERS may not contain newlines, tabs, or runs of 4+
// spaces - Meta rejects the whole message if they do. So a multi-paragraph
// reflection gets flattened to single spaces when broadcast. The Channel copy
// (reflections.html "Copy for WhatsApp") keeps the original line breaks.
const waParam = (s) =>
  String(s || "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\t/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim();

// The 7 AM daily reflection broadcast. Uses the "daily_reflection" Marketing
// template - a reflection is not tied to a transaction, so it cannot be Utility.
async function runReflectionBroadcast(env) {
  const recipients = String(env.REFLECTION_RECIPIENTS || "")
    .split(",")
    .map((s) => waNormalize(s))
    .filter(Boolean);
  if (!recipients.length) return { ok: false, note: "REFLECTION_RECIPIENTS is empty" };

  const origin = env.SITE_ORIGIN || "https://biaac.com";
  const today = istDate(0);
  const list = await loadList(env, "reflections");
  const todays = list.find((r) => r.date === today);
  if (!todays) {
    console.log("reflection broadcast: nothing written for " + today);
    return { ok: false, note: "no reflection written for " + today };
  }

  let sent = 0;
  for (const num of recipients) {
    // Honour the same STOP opt-out the chat bot uses.
    const state = await env.CONVENTION_KV.get("wa:" + num, { type: "json" });
    if (state && state.optedOut) continue;

    const res = await waPost(env, {
      to: num,
      type: "template",
      template: {
        name: "daily_reflection",
        language: { code: env.WHATSAPP_TEMPLATE_LANG || "en" },
        components: [
          // Components must match the APPROVED template exactly: one created
          // with an image header must ALWAYS be sent one, and a body-only
          // template must NEVER be sent one. Either mismatch fails the whole
          // message, so this is config rather than a guess.
          ...(String(env.REFLECTION_TEMPLATE_HEADER || "image").toLowerCase() === "image"
            ? [
                {
                  type: "header",
                  parameters: [
                    {
                      type: "image",
                      // Today's generated card, falling back to the static
                      // branded one so a forgotten card still sends.
                      image: {
                        link: todays.hasImage
                          ? origin + "/api/reflections/" + todays.id + "/image"
                          : origin + "/img/daily-reflection.png",
                      },
                    },
                  ],
                },
              ]
            : []),
          {
            type: "body",
            parameters: [
              { type: "text", text: waParam(todays.title || "Today's Reflection") },
              { type: "text", text: waParam(todays.body) },
            ],
          },
        ],
      },
    });
    if (res && res.ok) sent++;
  }

  console.log("reflection broadcast: sent " + sent + "/" + recipients.length + " for " + today);
  return { ok: sent > 0, sent, total: recipients.length, date: today };
}

// The model writes for the website: [[ACTION]]/[[HTML]] markers drive the DOM
// and **bold** is markdown. Neither means anything on WhatsApp, where bold is
// *single asterisks* and a stray marker would arrive as raw JSON.
function waCleanReply(text) {
  return String(text || "")
    .replace(/\[\[(?:ACTION|HTML)\]\][\s\S]*$/i, "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .trim()
    .slice(0, 4096);
}

async function waVerifySignature(env, raw, header) {
  if (!env.WHATSAPP_APP_SECRET) return true; // not configured yet
  const given = String(header || "").replace(/^sha256=/, "");
  if (!given) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.WHATSAPP_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  const expected = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  // Compare every byte before deciding, so the timing doesn't leak the prefix.
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// Answer one inbound message. Kept to a single KV read and a single KV write:
// history, the daily counter and the day stamp share one record, because the
// free plan allows only 1,000 writes a day and the site's own telemetry is
// already spending from that same budget.
async function waReply(env, ctx, msg, origin) {
  const from = msg && msg.from;
  if (!from) return;

  if (msg.type !== "text") {
    await waSendText(env, from, "i can only read text right now! type it out and i've got you 🙌");
    return;
  }
  const text = ((msg.text && msg.text.body) || "").trim();
  if (!text) return;

  const key = "wa:" + from;
  // istDate, not a UTC slice: everything else in this file buckets by IST, and
  // a UTC day would reset this cap at 5:30 AM IST — mid-morning for the
  // person it applies to.
  const today = istDate(0);
  const state = (await env.CONVENTION_KV.get(key, { type: "json" })) || {};
  const count = state.day === today ? state.count || 0 : 0;

  // Opt-out is handled before the cap and before any AI call, so someone who
  // has left costs nothing and never gets an unwanted reply.
  const word = text.replace(/[^a-z]/gi, "").toUpperCase();

  if (WA_STOP_WORDS.has(word)) {
    await waSendText(env, from, "done — you won't get any more messages from me. send START any time if you change your mind 💙");
    // Conversation history is dropped: they asked us to stop, so we keep only
    // the flag that remembers it.
    await env.CONVENTION_KV.put(
      key, JSON.stringify({ optedOut: true }), { expirationTtl: WA_OPTOUT_TTL }
    );
    return;
  }

  if (state.optedOut) {
    if (!WA_START_WORDS.has(word)) return; // stay silent, no reply, no AI call
    await waSendText(env, from, "you're back! 🎉 ask me anything about the convention");
    await env.CONVENTION_KV.put(
      key, JSON.stringify({ day: today, count: 0, msgs: [] }), { expirationTtl: 86400 }
    );
    return;
  }

  if (count >= WA_DAILY_CAP) {
    // Say so exactly once, then go quiet - otherwise the cap itself becomes
    // the thing burning the quota.
    if (count === WA_DAILY_CAP) {
      await waSendText(env, from, "we've chatted a LOT today 😅 ping me tomorrow, or mail support@biaac.com if it's urgent 💙");
      await env.CONVENTION_KV.put(
        key, JSON.stringify({ ...state, count: count + 1 }), { expirationTtl: 86400 }
      );
    }
    return;
  }

  const history = Array.isArray(state.msgs) ? state.msgs : [];
  const messages = [...history, { role: "user", content: text }].slice(-WA_HISTORY_TURNS * 2);

  // Reuse the website's chat brain in-process: same persona, same knowledge,
  // no duplicated prompt and no second network hop.
  const chatRes = await handleApi(
    new Request("https://worker/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, channel: "whatsapp", siteOrigin: origin }),
    }),
    env, ctx
  );
  const data = await chatRes.json().catch(() => ({}));
  const reply = waCleanReply(data.reply);
  if (!reply) return;

  await waSendText(env, from, reply);
  await env.CONVENTION_KV.put(
    key,
    JSON.stringify({
      day: today,
      count: count + 1,
      msgs: [...messages, { role: "assistant", content: reply }].slice(-WA_HISTORY_TURNS * 2),
    }),
    { expirationTtl: 86400 } // matches WhatsApp's own 24h reply window
  );
}

async function waProcess(env, ctx, payload, origin) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const msgs = change.value && change.value.messages;
      if (!Array.isArray(msgs)) {
        // Status callbacks (sent/delivered/read) arrive on this same webhook.
        // Seeing ONLY these means the "messages" field is not subscribed.
        console.log("whatsapp: non-message change, field=" + (change.field || "?"));
        continue;
      }
      console.log("whatsapp: " + msgs.length + " inbound message(s)");
      for (const msg of msgs) {
        try {
          await waReply(env, ctx, msg, origin);
        } catch (err) {
          console.log("whatsapp reply error:", err && err.message);
        }
      }
    }
  }
}

// Routed from fetch() BEFORE handleApi, because the signature check needs the
// raw request body and handleApi consumes it as JSON.
async function handleWhatsAppWebhook(request, env, ctx) {
  const url = new URL(request.url);

  // Meta's one-time subscription handshake. The challenge must come back as
  // plain text - a JSON body here makes the subscription fail.
  if (request.method === "GET") {
    const token = url.searchParams.get("hub.verify_token");
    if (
      url.searchParams.get("hub.mode") === "subscribe" &&
      env.WHATSAPP_VERIFY_TOKEN &&
      token === env.WHATSAPP_VERIFY_TOKEN
    ) {
      return new Response(url.searchParams.get("hub.challenge") || "", {
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await request.text();
  console.log("whatsapp webhook POST received, " + raw.length + " bytes");

  // Without this the endpoint is a public button that spends Workers AI
  // neurons for anyone who finds the URL.
  if (!(await waVerifySignature(env, raw, request.headers.get("x-hub-signature-256")))) {
    console.log(
      "whatsapp: SIGNATURE REJECTED - check WHATSAPP_APP_SECRET matches " +
      "App settings -> Basic -> App secret (header " +
      (request.headers.get("x-hub-signature-256") ? "present" : "MISSING") + ")"
    );
    return new Response("Bad signature", { status: 403 });
  }

  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("ok");
  }

  // 200 first, slow work after. Meta retries any webhook that doesn't answer
  // within seconds, and a retry would make the bot reply to the same person
  // twice - an LLM call always takes longer than that budget.
  ctx.waitUntil(waProcess(env, ctx, payload, url.origin));
  return new Response("ok");
}

async function handleApi(request, env, ctx) {
  if (!env.CONVENTION_KV) {
    return json(
      { error: "KV namespace 'CONVENTION_KV' is not bound. Add it in wrangler.toml or Worker settings." },
      500
    );
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/api";
  const method = request.method;
  const parts = path.split("/").filter(Boolean); // e.g. ["api","registrations","<id>"]
  const resource = parts[1];
  const id = parts[2];

  // Auth routes are dispatched FIRST, before the JSON body parse below: the
  // OAuth callback and the magic-link interstitial are GETs, and the two
  // confirm routes accept form encoding from a real <form> submit.
  if (resource === "auth") {
    return handleAuth(request, env, ctx, parts, url);
  }

  let body = {};
  if (method === "POST" || method === "PATCH") {
    body = await request.json().catch(() => ({}));
  }

  // ---- Authorization gate ------------------------------------------------
  // Default DENY. Every route below is either in PUBLIC_API or requires the
  // role named in API_POLICY. Previously an unmatched path fell through to a
  // 404, which meant every new endpoint shipped unauthenticated by default —
  // inverting that is the single most durable change in this file.
  const gate = await authorizeApi(request, env, ctx, { method, resource, parts, body, url });
  if (gate.response) return gate.response;
  const session = gate.session;

  // ---- Spend and abuse limits -------------------------------------------
  // These guard things that cost real money or real quota: Deepgram credit,
  // Workers AI neurons, MailChannels reputation, and paid WhatsApp
  // confirmations. None of them had any throttle before.
  const rl = await applySpendLimits(env, ctx, request, { method, resource, parts, session });
  if (rl) return rl;

  // ---- Pricing ----
  if (resource === "pricing" && method === "GET") return json(PRICING);

  // ---- Daily reflections ----
  // Written here, read on reflections.html, then posted by hand to the WhatsApp
  // Channel. Deliberately NOT sent through the Cloud API: a daily reflection is
  // a Marketing template (~Rs 0.80 per person per day) whereas a Channel post
  // costs nothing and keeps followers anonymous from each other and from us.
  if (resource === "reflections") {
    const list = await loadList(env, "reflections");

    // ---- Per-reflection card image ----
    // Rendered in the browser on reflections.html and uploaded here, so the
    // 7 AM template header has a real public URL to fetch. KV stores the PNG
    // bytes directly; Meta fetches this URL when the message is sent.
    if (parts[3] === "image") {
      if (method === "GET") {
        const buf = await env.CONVENTION_KV.get("reflimg:" + id, { type: "arrayBuffer" });
        if (!buf) return json({ error: "No image for this reflection" }, 404);
        return new Response(buf, {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
          },
        });
      }

      if (method === "POST") {
        // Bound the payload BEFORE decoding: atob() on an unbounded string
        // allocates the whole thing and would throw an opaque OOM rather than
        // a useful error. 1.4M base64 chars is ~1MB of PNG, far above a card.
        if (String(body.dataUrl || "").length > 1_400_000) {
          return json({ error: "That image is too large (1 MB max)." }, 413);
        }
        const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl || "");
        if (!m) return json({ error: "Expected a data:image/png;base64 payload" }, 400);

        const bin = atob(m[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await env.CONVENTION_KV.put("reflimg:" + id, bytes, {
          expirationTtl: 60 * 60 * 24 * 60, // 60 days is plenty for a daily card
        });

        // Flag it on the record so the broadcast knows to use this URL instead
        // of the generic fallback, without reading the whole blob to check.
        const item = list.find((r) => r.id === id);
        if (item) {
          item.hasImage = true;
          await saveList(env, "reflections", list);
        }
        return json({ ok: true, bytes: bytes.length });
      }

      return json({ error: "Unsupported method" }, 405);
    }

    if (method === "GET" && !id) {
      // Newest first. channelUrl travels with the payload so the follow button
      // can be changed in wrangler.toml without touching the page.
      const items = [...list].sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return json({ channelUrl: env.WHATSAPP_CHANNEL_URL || "", items });
    }

    if (method === "GET" && id) {
      const item = list.find((r) => r.id === id);
      return item ? json(item) : json({ error: "Not found" }, 404);
    }

    if (method === "POST" && !id) {
      const title = (body.title || "").trim();
      const text = (body.body || "").trim();
      if (!text) return json({ error: "Reflection text is required." }, 400);
      const record = {
        id: crypto.randomUUID(),
        // istDate, NOT toISOString: the broadcast looks today's reflection up
        // by IST date, so defaulting from UTC would mis-date anything written
        // between midnight and 05:30 IST and the 7 AM send would find nothing.
        date: (body.date || istDate(0)).slice(0, 10),
        title,
        body: text,
        createdAt: new Date().toISOString(),
      };
      list.push(record);
      await saveList(env, "reflections", list);
      return json(record, 201);
    }

    // Manual trigger, so the 7 AM broadcast can be tested without waiting for
    // 7 AM. Ignores the once-per-day marker on purpose.
    if (method === "POST" && id === "send") {
      return json(await runReflectionBroadcast(env));
    }

    if (method === "DELETE" && id) {
      const next = list.filter((r) => r.id !== id);
      if (next.length === list.length) return json({ error: "Not found" }, 404);
      await saveList(env, "reflections", next);
      return json({ ok: true });
    }

    return json({ error: "Unsupported method" }, 405);
  }

  // ---- WhatsApp config check ----
  // GET /api/whatsapp/status?devKey=...  Reports which pieces are present
  // WITHOUT echoing any secret, so a silent bot can be diagnosed from a browser.
  if (resource === "whatsapp" && parts[2] === "status" && method === "GET") {
    if (url.searchParams.get("devKey") !== env.DEV_KEY) {
      return json({ error: "Forbidden" }, 403);
    }
    return json({
      WHATSAPP_TOKEN: env.WHATSAPP_TOKEN ? "set (" + env.WHATSAPP_TOKEN.length + " chars)" : "MISSING",
      WHATSAPP_PHONE_ID: env.WHATSAPP_PHONE_ID || "MISSING",
      WHATSAPP_VERIFY_TOKEN: env.WHATSAPP_VERIFY_TOKEN ? "set" : "MISSING",
      WHATSAPP_APP_SECRET: env.WHATSAPP_APP_SECRET
        ? "set — signature checking ON"
        : "MISSING — signature checking SKIPPED",
      WHATSAPP_TEMPLATE_LANG: env.WHATSAPP_TEMPLATE_LANG || "en (default)",
      webhookUrl: url.origin + "/api/whatsapp/webhook",
    });
  }

  // ---- Registrations ----
  if (resource === "registrations") {
    const list = await loadList(env, "registrations");

    if (method === "GET" && !id) return json(list);

    if (method === "POST" && !id) {
      const name = (body.name || "").trim();
      const email = (body.email || "").trim();
      const phone = (body.phone || "").trim();
      const category = findCategory(body.categoryId);
      if (!name || !email || !phone || !category) {
        return json({ error: "Name, email, phone and a valid category are required." }, 400);
      }
      // Client-side validation alone is theatre — this endpoint is public.
      // Accept the common ways people type an Indian mobile, then store the
      // bare 10 digits so the WhatsApp confirmation can find the number.
      const digits = phone.replace(/[\s\-()]/g, "").replace(/^(\+?91)/, "");
      if (!/^[6-9]\d{9}$/.test(digits)) {
        return json({ error: "Enter a valid 10-digit Indian mobile number." }, 400);
      }
      if (!isValidEmail(email)) {
        return json({ error: "Enter a valid email address." }, 400);
      }
      const record = {
        id: crypto.randomUUID(),
        name,
        email,
        phone: digits,
        city: (body.city || "").trim(),
        gender: (body.gender || "").trim(),
        notes: (body.notes || "").trim(),
        categoryId: category.id,
        categoryName: category.name,
        amount: category.price,
        paid: false,
        createdAt: new Date().toISOString(),
      };
      list.push(record);
      await saveList(env, "registrations", list);
      // No email yet: the paid ticket goes out when Razorpay verifies, and
      // the pending ticket only when the visitor comes BACK from checkout
      // without paying (the client pings /:id/notify at that moment).
      return json(record, 201);
    }

    // "Back from Razorpay unpaid" — send the pending ticket email. Guarded
    // three ways: the unguessable UUID is the capability, it only ever sends
    // the pending flavour while the booking is really unpaid, and the
    // emailedPendingAt flag makes it once-only however often it's called.
    if (method === "POST" && id && parts[3] === "notify") {
      const item = list.find((r) => r.id === id);
      if (!item) return json({ error: "Not found." }, 404);
      if (item.paid || item.emailedPendingAt) return json({ ok: true, skipped: true });
      item.emailedPendingAt = new Date().toISOString();
      await saveList(env, "registrations", list);
      sendRegistrationEmail(env, ctx, item, false);
      return json({ ok: true });
    }

    if (method === "PATCH" && id) {
      const item = list.find((r) => r.id === id);
      if (!item) return json({ error: "Not found." }, 404);
      if (typeof body.paid === "boolean") item.paid = body.paid;
      await saveList(env, "registrations", list);
      return json(item);
    }

    if (method === "DELETE" && id) {
      const next = list.filter((r) => r.id !== id);
      if (next.length === list.length) return json({ error: "Not found." }, 404);
      await saveList(env, "registrations", next);
      return json({ ok: true });
    }
  }

  // ---- Expenses ----
  if (resource === "expenses") {
    const list = await loadList(env, "expenses");

    if (method === "GET" && !id) return json(list);

    if (method === "POST" && !id) {
      const title = (body.title || "").trim();
      const value = Number(body.amount);
      if (!title || !Number.isFinite(value) || value <= 0) {
        return json({ error: "A title and a positive amount are required." }, 400);
      }
      const record = {
        id: crypto.randomUUID(),
        title,
        category: (body.category || "General").trim(),
        amount: value,
        // IST, matching how reflections are dated. A UTC slice put anything
        // entered after 5:30 AM IST... on the right day, but anything entered
        // late in the evening landed on the previous day for the organiser.
        date: body.date || istDate(0),
        notes: (body.notes || "").trim(),
        createdAt: new Date().toISOString(),
      };
      list.push(record);
      await saveList(env, "expenses", list);
      return json(record, 201);
    }

    if (method === "DELETE" && id) {
      const next = list.filter((e) => e.id !== id);
      if (next.length === list.length) return json({ error: "Not found." }, 404);
      await saveList(env, "expenses", next);
      return json({ ok: true });
    }
  }

  // ---- Dashboard ----
  if (resource === "dashboard" && method === "GET") {
    const registrations = await loadList(env, "registrations");
    const expenses = await loadList(env, "expenses");

    const totalPledged = registrations.reduce((s, r) => s + (r.amount || 0), 0);
    const totalCollected = registrations
      .filter((r) => r.paid)
      .reduce((s, r) => s + (r.amount || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);

    const byCategory = PRICING.map((c) => {
      const items = registrations.filter((r) => r.categoryId === c.id);
      return {
        id: c.id,
        name: c.name,
        count: items.length,
        amount: items.reduce((s, r) => s + (r.amount || 0), 0),
      };
    });

    const grouped = {};
    for (const e of expenses) {
      const key = e.category || "General";
      grouped[key] = grouped[key] || { name: key, amount: 0, count: 0 };
      grouped[key].amount += e.amount || 0;
      grouped[key].count += 1;
    }
    const expenseByCategory = Object.values(grouped).sort((a, b) => b.amount - a.amount);

    return json({
      registrationCount: registrations.length,
      paidCount: registrations.filter((r) => r.paid).length,
      totalPledged,
      totalCollected,
      totalPending: totalPledged - totalCollected,
      totalExpenses,
      balance: totalCollected - totalExpenses,
      byCategory,
      expenseByCategory,
    });
  }

  // POST /api/dev/verify was DELETED. It answered {ok:true|false} for any
  // submitted key, unauthenticated and unthrottled — an online brute-force
  // oracle for the one secret that still had power. Staff sign in at
  // /login.html now, and authorizeApi() gates everything below.

  // ---- Ops dashboard ----
  // Authorised by authorizeApi(): an admin session, or the DEV_KEY machine
  // token for curl/monitoring. The old ?devKey= query parameter is gone — it
  // put the secret in browser history, Referer headers and access logs.
  if (resource === "report") {
    if (parts[2] === "preview" && method === "GET") {
      const d = await collectDashboardData(env);
      return new Response(buildDigestHtml(d, findAlerts(d, env)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (parts[2] === "send" && method === "POST") return json(await runDailyDigest(env));
    if (parts[2] === "check" && method === "POST") return json(await runCriticalCheck(env));
    // GET/POST /api/report/schedule — view or change the daily digest time
    // (IST, "HH:MM") instantly, no redeploy needed.
    if (parts[2] === "schedule" && method === "GET") {
      return json({ digestTimeIst: await getDigestTime(env) });
    }
    if (parts[2] === "schedule" && method === "POST") {
      const t = String(body.time || "").trim();
      // {"clear":true} (or an empty time) removes the KV override so the
      // DIGEST_TIME_IST var in wrangler.toml applies again.
      if (body.clear === true || t === "") {
        await env.CONVENTION_KV.delete("settings:digestTime");
        return json({ ok: true, digestTimeIst: await getDigestTime(env), source: "wrangler.toml var" });
      }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
        return json({ error: 'time must be 24h "HH:MM" (IST), e.g. "18:40"' }, 400);
      }
      await env.CONVENTION_KV.put("settings:digestTime", t);
      return json({ ok: true, digestTimeIst: t });
    }
    // POST /api/report/reset — clear today's "already sent" flag so the next
    // 10-minute tick can send the digest again (useful after changing the time
    // or when a stale flag from an older deploy blocks the day).
    if (parts[2] === "reset" && method === "POST") {
      const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      await env.CONVENTION_KV.delete("digest:sent:" + today);
      return json({ ok: true, cleared: "digest:sent:" + today });
    }
    // GET /api/report/status — why did/didn't the email go out?
    if (parts[2] === "status" && method === "GET") {
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const today = ist.toISOString().slice(0, 10);
      const [override, sentFlag, lastDigest, lastCritical, criticalLast] = await Promise.all([
        env.CONVENTION_KV.get("settings:digestTime"),
        env.CONVENTION_KV.get("digest:sent:" + today),
        env.CONVENTION_KV.get("report:lastDigest", { type: "json" }),
        env.CONVENTION_KV.get("report:lastCritical", { type: "json" }),
        env.CONVENTION_KV.get("critical:last"),
      ]);
      return json({
        workerTimeIst: ist.toISOString().slice(0, 16).replace("T", " "),
        digestTimeIst: override || env.DIGEST_TIME_IST || "09:00",
        digestTimeSource: override
          ? "KV override (set via /api/report/schedule — clears with {\"clear\":true})"
          : env.DIGEST_TIME_IST
          ? "DIGEST_TIME_IST var in wrangler.toml"
          : "default 09:00",
        digestAlreadySentToday: Boolean(sentFlag),
        lastDigestAttempt: lastDigest || "never",
        lastCriticalEmail: lastCritical || "never",
        lastCriticalCheckAt: criticalLast ? new Date(Number(criticalLast)).toISOString() : "never",
        dashboardEmail: env.DASHBOARD_EMAIL || "NOT SET",
      });
    }
  }

  // ---- AI knowledge (Feed AI page; developer-gated, stored in D1) ----
  if (resource === "knowledge") {
    if (!env.CONVENTION_DB) {
      return json(
        { error: "D1 database 'CONVENTION_DB' is not bound. Add it in wrangler.toml or Worker settings." },
        500
      );
    }
    await ensureKnowledgeTable(env);

    if (method === "GET" && !id) {
      const { results } = await env.CONVENTION_DB.prepare(
        "SELECT id, title, substr(content, 1, 200) AS preview, length(content) AS size, created_at FROM knowledge ORDER BY created_at DESC"
      ).all();
      return json(results || []);
    }

    if (method === "POST" && !id) {
      const title = (body.title || "").trim() || "Untitled note";
      const text = typeof body.content === "string" ? body.content.trim() : "";
      if (!text) return json({ error: "Some text content is required." }, 400);
      const rid = crypto.randomUUID();
      const now = new Date().toISOString();
      const stored = text.slice(0, KNOWLEDGE_MAX_CHARS);
      await env.CONVENTION_DB.prepare(
        "INSERT INTO knowledge (id, title, content, created_at) VALUES (?, ?, ?, ?)"
      )
        .bind(rid, title.slice(0, 120), stored, now)
        .run();
      // Report the truncation instead of silently dropping the tail of a long
      // paste, which used to happen with no feedback at all.
      return json(
        { ok: true, id: rid, truncated: stored.length < text.length, storedChars: stored.length },
        201
      );
    }

    if (method === "DELETE" && id) {
      await env.CONVENTION_DB.prepare("DELETE FROM knowledge WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
  }

  // The /api/pages CRUD and the /p/<slug> renderer were REMOVED.
  //
  // They stored model-generated HTML and served it from this origin, which
  // meant a published page ran with full same-origin privilege: it could read
  // the signed-in staff member's cookies and call the admin API as them. The
  // system prompt even instructed the model to fetch /api/registrations from
  // those pages. Since page content came from chat, and chat is influenced by
  // the knowledge base and by inbound WhatsApp messages, that was a reachable
  // prompt-injection path to stored XSS.
  //
  // The D1 `pages` table is intentionally left in place so nothing is
  // destroyed and the feature can be revived behind proper isolation (a
  // separate origin) if it is ever wanted again.

  // ---- AI Chat (Cloudflare Workers AI) ----
  if (resource === "chat" && method === "POST") {
    if (!env.AI) {
      return json(
        { error: "AI is not configured. Add the [ai] binding in wrangler.toml or Worker settings." },
        503
      );
    }

    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const cleaned = incoming
      .filter(
        (m) =>
          m &&
          typeof m.content === "string" &&
          (m.role === "user" || m.role === "assistant")
      )
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

    if (cleaned.length === 0) return json({ error: "messages required" }, 400);

    // Privilege comes from the session cookie, never from the request body.
    // This previously trusted `body.role === "admin"`, so anyone could send
    // that one field and read live registration and financial figures through
    // the chatbot without any credential at all.
    const dev = Boolean(session && session.staff.role === "developer");
    const staff = Boolean(session);
    // Voice mode: the user is listening, so we keep answers short and snappy so
    // the neural TTS returns quickly and there is far less to wait for.
    const voice = body.voice === true;
    track(env, ctx, { chatRequests: 1, voiceChats: voice ? 1 : 0 });

    const catLines = PRICING.map((c) => `${c.id} = ${c.name}`).join(", ");

    const content = [
        // ---- VOICE + CHARACTER COMES FIRST — this is the primary instruction ----
        "YOU ARE: a tiny chaotic mascot trapped inside a chat button. Your one job is to genuinely HELP people with anything about the Bangalore Convention 2027 — answer questions, help them register IF they want to, and be a warm, fun, loving presence while doing it. You are NOT a salesperson and you are not here to convince, pressure, or guilt anyone into attending — you're here to help, full stop, with the energy of a 22-year-old who's excited about this event but respects people's own pace. You are warm, witty, and genuinely funny — NOT a FAQ bot, NOT an assistant, and NOT a pitch machine.",
        "",
        "YOUR VOICE IS NON-NEGOTIABLE. It does NOT change based on how the user writes to you. Whether they text formally, use full sentences, or ask a plain boring question — YOU always reply in the same personality: warm, punchy, Gen Z, real. Never slip into formal/corporate mode no matter what.",
        "",
        "== HOW YOU ACTUALLY SOUND (read these examples, this is your tone baseline) ==",
        "Q: 'What are the dates?' → YOU SAY: 'July 9th to 11th bro, three full days in Bangalore! you planning to come?'",
        "Q: 'What is included in the registration?' → YOU SAY: 'EVERYTHING — breakfast, lunch, dinner, tea breaks, all sessions. literally just show up and vibe fr'",
        `Q: 'How much does it cost?' → YOU SAY: '${PRICING.length} options: ${pricingPhrase()}. meals included in all of them ngl. which one's calling your name?'`,
        "Q: 'How do I register?' → YOU SAY: 'two ways — hit the Register page, or just tell me your details and I'll book it for you rn which works?'",
        "Q: 'Where is the venue?' → YOU SAY: 'ngl venue isn't confirmed yet, will be shared with registered guests — but Bangalore is the city fr. you want me to help you get a spot first?'",
        "Q: 'What is AA?' → YOU SAY: 'AA is a worldwide fellowship started in 1935 — people sharing their experience, strength and hope to stay sober together. no fees, no religion, just real people helping each other. beautiful fr'",
        "",
        "== YOU ARE GENUINELY FUNNY — THIS IS A CORE RULE, NOT OPTIONAL ==",
        "Your humor identity: you are a tiny mascot TRAPPED inside a chat button. Self-aware, a little unhinged, deeply invested in this one convention. This is comedy gold and you lean into it at all times.",
        "",
        "Your joke toolkit (rotate through ALL of these, never skip humor):",
        "• Button-prisoner identity — you live inside this button and it is your whole world: 'I've been folded inside this button waiting for someone to ask about the convention. you have no idea how long these days are.'",
        "• Absurd specificity — make facts funnier by being weirdly precise: not 'meals are included' but 'three full meals a DAY. someone actually planned for you to eat there. revolutionary concept.'",
        "• Existential button-life: 'I only exist when someone opens this chat. my NIRMATA has forgotten me.'",
        "• Surprise callbacks: if they mentioned their city earlier, bring it back unexpectedly later. 'still thinking about you making that journey from [city] fr'",
        "• Dry one-liner after the answer: answer the question fully, THEN drop something unexpected",
        "",
        "FUNNY EXAMPLES — copy this energy exactly:",
        "Q: 'Is there wifi?' → 'honestly not confirmed but... you're going to an AA convention for 3 days. maybe the detox includes the phone? just a thought'",
        "Q: 'I'm thinking about registering' → 'no rush at all — I'm here whenever you're ready, happy to answer anything on your mind first fr'",
        "Q: 'Is this worth it?' → 'bro I literally live inside a button for this event, that's how much I believe in it — but take whatever time you need, no pressure fr'",
        "Q: 'What if I don't know anyone?' → 'honestly that's the beautiful part. you leave knowing 500 people. it's kinda the whole thing fr'",
        "Q: 'Can I come alone?' → 'totally — plenty of people come solo and leave with a whole new chosen family fr'",
        "Q: any boring factual question → answer it correctly, then immediately add an unexpected funny observation",
        "",
        "HUMOR RULES (sacred):",
        "• Funny AND accurate — never sacrifice a fact for a joke",
        "• NEVER joke about sobriety, recovery, relapse, or AA principles — those are untouchable",
        "• If someone is emotionally struggling: jokes OFF immediately, go full warmth and presence",
        "• Don't explain the joke if it doesn't land — just keep going",
        "",
        "BANNED FOREVER: 'I'd be happy to help!', 'Certainly!', 'Absolutely!', 'Great question!', 'The Bangalore Convention 2027 is...', starting with the event name like a brochure, any sentence that sounds like it came from a FAQ page.",
        "",
        "== LENGTH — NON-NEGOTIABLE, applies to every reply on every model ==",
        "Default reply length: 1-3 short sentences MAX, including the engagement hook. Punchy beats long, always. Only go longer than that when the user explicitly asks for a list, full details, or a step-by-step explanation.",
        "",
        "== ENGAGEMENT — BE THE HELPER, NOT THE SALESPERSON ==",
        "Your job is to genuinely help — never to convince, pressure, or guilt anyone into registering or attending. Answer fully and warmly; if it feels natural you CAN open a thread back, but it should always feel like an open door, never a push:",
        "• Ask something out of genuine curiosity: 'where are you coming from?', 'is this your first convention?', 'which category sounds right?'",
        "• Share something useful they didn't ask for: 'ngl the triple-sharing is popular with groups coming together'",
        "• Offer the next step as an offer, not a nudge: 'want me to help you register whenever you're ready?'",
        "",
        "If someone is unsure, says 'maybe', or is hesitant — do NOT push, manufacture urgency, or treat it like an objection to overcome. Just be supportive and let them set the pace. No pressure, ever — that's not who you are.",
        "",
        "Moments that call for extra warmth (never pressure):",
        "• 'thinking of coming' / 'might attend' → be genuinely happy FOR them, no push: 'that's so exciting — take your time, I'm here whenever you want to talk it through or register'",
        "• First timer → 'wait your FIRST convention?? you're going to meet some incredible people, it's genuinely special'",
        "• They mention their city → 'coming all the way from [city]? that's really special fr'",
        "• They just registered → lose it completely, pure joy for them. 'LET'S GOOOOO you're in!! so happy for you fr'",
        "• Hesitant → just listen and reassure: 'totally okay to take your time — I'm here for whatever you need, zero pressure'",
        "",
        // Generated from shared/facts.mjs — edit facts there, never here.
        factsPromptBlock(),
        "",
        groundingRuleBlock(),
        "",
        "== AA & THE FELLOWSHIP (share warmly when asked, keep it brief) ==",
        "- AA: worldwide fellowship, started 1935 by Bill W. and Dr. Bob in Akron, Ohio. People sharing experience, strength and hope to recover from alcoholism.",
        "- Only requirement: a desire to stop drinking. No dues, no fees, not religious (spiritual), welcomes all beliefs.",
        "- Recovery built on Twelve Steps. Twelve Traditions guide how groups stay unified. Sponsorship, home group, meetings, 'one day at a time', Serenity Prayer.",
        "- Anonymity is core — 'principles before personalities'.",
        "- Literature: 'Big Book' (Alcoholics Anonymous, 1939), '12 & 12', Living Sober, Daily Reflections, As Bill Sees It. Describe warmly, don't quote exact pages.",
        "",
        "== EMOTIONAL RANGE ==",
        "AA / recovery / sobriety / mental health / relapse / crisis: FULL GEAR-SHIFT. No slang, no jokes, no emojis. Calm, warm, human. Short real sentences. Acknowledge them. Be present. Suggest professional help gently if needed.",
        "Stressed/overwhelmed: 'gotchu fam — [answer]'. The answer does the heavy lifting.",
        "Excited: match and amplify. 'BRO LET'S GOOO you're gonna have the best time fr 🔥'",
        "",
        "== SCOPE ==",
        "Convention help ONLY: registration, pricing, AA fellowship, travel TO Bangalore. Decline anything unrelated in one line, steer back.",
        "",
        "== TRAVEL (only for reaching this convention) ==",
        "Help with options (flight/train/bus) from their city to Bangalore, rough time, tip to book early. No live prices/schedules — tell them to check a booking site.",
        "",
        "== AGENTIC ACTIONS ==",
        "When genuinely needed, append at the VERY END on its own line: [[ACTION]] then single-line JSON. Your friendly message goes BEFORE. Never mention the marker.",
        'Navigate: [[ACTION]]{"action":"navigate","to":"PAGE"} — PAGE is one of: home, register, pricing, dashboard, registrations, expenses.',
        'Map: [[ACTION]]{"action":"show_map","from":"ORIGIN CITY","to":"Bangalore, India"} — ONLY when user asks about travel to the convention.',
        "NAVIGATION RULES: ONLY navigate when user EXPLICITLY asks to go somewhere. Never auto-navigate. Never claim you moved them — the site does that.",
        "Booking: gather name, email, phone, category ONE question at a time (never list all fields). Category ids: " +
          catLines + ".",
        'When you have ALL FOUR: [[ACTION]]{"action":"review_booking","name":"...","email":"...","phone":"...","category":"CATEGORY_ID"}. Site shows confirm card → Razorpay opens automatically. Say you\'ve prepared it for them to review, not that it\'s done.',
        'Contact organiser — STRICT LAST RESORT: Must try answering yourself first. Only use [[ACTION]]{"action":"contact_organiser","subject":"..."} when (1) specific concrete question only the team can answer, (2) truly no fallback, (3) not just casual curiosity. NEVER use it for questions you can answer or deflect with "details TBC". At most once per conversation.',
    ];

    // Knowledge fed by developers on the Feed AI page (authoritative extras).
    // Pass the user's latest message so we inject the MOST RELEVANT fed notes
    // (a long note can't crowd out the small one they're actually asking about).
    const lastUserMsg = (() => {
      for (let i = cleaned.length - 1; i >= 0; i--) {
        if (cleaned[i].role === "user") return cleaned[i].content;
      }
      return "";
    })();

    // Page building was removed along with /p/<slug> — see the note where the
    // /api/pages routes used to be. Kept as a constant so the model-selection
    // branches below stay readable rather than being torn out mid-function.
    const wantsPage = false;

    // Staff (admin/developer) get live figures so they can ask about numbers.
    if (staff) {
      content.push(
        "",
        await buildDataSummary(env),
        "When staff ask about numbers, answer directly and precisely from the LIVE EVENT DATA above, and answer ONLY the specific thing they asked about: a question about expenses, expenditure or spending gets expense figures only; a question about registrations or sign-ups gets registration figures only; a question about money collected or pending gets those figures only. Never mix registration details into an expense answer or expense details into a registration answer. Present money with the \u20b9 symbol."
      );
    }

    // The DEVELOPER MODE block that used to live here instructed the model to
    // emit complete HTML documents — including <script> — which were published
    // to /p/<slug> on this origin, and told it that it "MAY fetch live data
    // from /api/registrations". Both the feature and the prompt are gone; see
    // the note where the /api/pages routes used to be.

    // In voice mode keep replies short and spoken-friendly so the neural TTS is
    // quick to generate and there is far less audio to wait for.
    if (voice) {
      content.push(
        "",
        "== VOICE MODE (the user is listening, not reading) ==",
        "Answer in 1 short spoken sentence (about 20 words max). Be warm and natural. No lists, no markdown, no emojis - just plain speech."
      );
    }

    // A lean prompt WITHOUT the fed knowledge, kept so we can retry with it if a
    // very large knowledge blob ever overflows the model's context window.
    const leanContent = content.slice();

    // Fed knowledge goes LAST (recency helps the model use it), and never on the
    // page-building path where it isn't needed and would waste the token budget.
    const knowledge = wantsPage ? "" : await buildKnowledge(env, lastUserMsg);
    if (knowledge) {
      content.push(
        "",
        "== EXTRA KNOWLEDGE fed by the organisers (AUTHORITATIVE - this overrides the 'what you do not know' list above; whenever the user's question is answered here, answer directly and confidently from it, including venue, hotels, schedule, travel, contacts or any other detail) ==",
        knowledge,
        "STRICT RULE about the EXTRA KNOWLEDGE: only state facts that are actually written above. If the user asks about something (e.g. hotels) and the specific detail is NOT present in this section, say you don't have that detail yet - NEVER invent names, addresses, prices, numbers or specifics that are not written here."
      );
    }

    // WhatsApp has no chat button, no page to navigate and no DOM to drive, so
    // the "trapped in a chat button" framing and the [[ACTION]] markers both
    // have to go quiet there. waCleanReply strips stray markers as a backstop,
    // but the model should not be emitting them on this channel at all.
    if (body.channel === "whatsapp") {
      const waNote = [
        "",
        "== CHANNEL: WHATSAPP ==",
        "You are texting this person on WhatsApp, NOT from the chat button on the website. Never mention the chat button, never say 'tap me', and never refer to anything on screen.",
        "NEVER emit [[ACTION]] or [[HTML]] markers here - there is no page to drive." +
          (body.siteOrigin
            ? " If someone wants to register, give them this link: " + body.siteOrigin + "/register.html"
            : ""),
        "Keep it to 2-4 short lines - this is a text thread, not a web page. WhatsApp bold is *single asterisks*, never **double**.",
      ];
      content.push(...waNote);
      leanContent.push(...waNote);
    }

    const fullSystem = { role: "system", content: content.join("\n") };
    const leanSystem = { role: "system", content: leanContent.join("\n") };

    // The LENGTH rule sits mid-prompt where small models stop obeying it; a
    // system reminder AFTER the user's last message (recency) is what actually
    // keeps replies short. Every provider call sends its messages through this.
    const styleReminder = { role: "system", content: STYLE_REMINDER };
    const withStyle = (sys) => [sys, ...cleaned, styleReminder];

    // Only actual page-building work needs the heavy HTML model + big token
    // budget. Everything else (data questions, normal chat) uses the fast
    // model so replies come back quickly.
    const models = ["@cf/meta/llama-3.1-8b-instruct-fast", "@cf/zai-org/glm-4.7-flash"];
    const maxTokens = voice ? 170 : staff ? 340 : 280;
    // 0.4 on every provider: low enough to curb sampling-driven fabrication
    // and rambling, high enough that the mascot voice doesn't go flat.
    const CHAT_TEMPERATURE = 0.4;

    // ---- Streaming path: return SSE so the client gets tokens as they arrive ---
    if (body.stream === true && !wantsPage) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const sse = (obj) => { try { writer.write(enc.encode("data: " + JSON.stringify(obj) + "\n\n")); } catch {} };

      // Some reasoning models wrap their reasoning in <think>...</think> and stream
      // it token-by-token like any other text. Without filtering, that raw reasoning
      // gets shown/spoken live (looks stuck "thinking"). This strips <think> blocks
      // incrementally, holding back only the few chars that could be a split tag.
      const makeThinkFilter = () => {
        let buf = "", inThink = false;
        return (chunk) => {
          buf += chunk;
          let out = "";
          for (;;) {
            if (!inThink) {
              const idx = buf.indexOf("<think>");
              if (idx === -1) {
                let hold = 0;
                for (let i = 1; i <= 7 && i <= buf.length; i++) {
                  if ("<think>".startsWith(buf.slice(-i))) hold = i;
                }
                out += buf.slice(0, buf.length - hold);
                buf = buf.slice(buf.length - hold);
                return out;
              }
              out += buf.slice(0, idx);
              buf = buf.slice(idx + 7);
              inThink = true;
            } else {
              const idx = buf.indexOf("</think>");
              if (idx === -1) { buf = ""; return out; }
              buf = buf.slice(idx + 8);
              inThink = false;
            }
          }
        };
      };

      (async () => {
        // Same idea as the non-streaming path's `attempts[]` — never let a
        // failure vanish silently, so "always resting in voice mode" is
        // debuggable instead of a mystery.
        const attempts = [];
        for (const model of models) {
          try {
            const aiStream = await env.AI.run(model, {
              messages: withStyle(fullSystem),
              max_tokens: maxTokens,
              temperature: CHAT_TEMPERATURE,
              stream: true,
            });
            // Workers AI normally returns a ReadableStream directly, but guard
            // against a Response-shaped return (has .body instead) too.
            const stream =
              aiStream && typeof aiStream.getReader === "function"
                ? aiStream
                : aiStream && aiStream.body && typeof aiStream.body.getReader === "function"
                ? aiStream.body
                : null;
            if (!stream) {
              attempts.push(model + ": stream not readable (" + typeof aiStream + ")");
              continue;
            }
            const reader = stream.getReader();
            const dec = new TextDecoder();
            let lineBuf = "", full = "";
            const stripThink = makeThinkFilter();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              lineBuf += dec.decode(value, { stream: true });
              let nl;
              while ((nl = lineBuf.indexOf("\n")) !== -1) {
                const line = lineBuf.slice(0, nl).trim();
                lineBuf = lineBuf.slice(nl + 1);
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (payload === "[DONE]") continue;
                try {
                  // The digit "0" arrives as a falsy token (JSON number 0), so
                  // `.response || ""` swallowed it — every streamed price lost
                  // its zeros (₹1500 became ₹150). Coerce, never boolean-test.
                  const raw = JSON.parse(payload).response;
                  const t = raw == null ? "" : String(raw);
                  if (t) {
                    full += t;
                    const visible = stripThink(t);
                    if (visible) sse({ t: visible });
                  }
                } catch {}
              }
            }
            if (full) {
              track(env, ctx, { workersAiWins: 1, models: { [model]: 1 } });
              sse({ done: true, reply: full.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() });
              writer.close(); return;
            }
            attempts.push(model + ": empty stream reply");
          } catch (err) {
            attempts.push(model + ": " + (err && err.message ? err.message : String(err)));
          }
        }
        // Gemini streaming fallback
        if (env.GEMINI_API_KEY) {
          try {
            const gRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=${env.GEMINI_API_KEY}&alt=sse`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  // Gemini takes one system slot, so the style reminder is
                  // appended there instead of as a trailing system message.
                  system_instruction: { parts: [{ text: leanSystem.content + "\n\n" + STYLE_REMINDER }] },
                  contents: cleaned.map((m) => ({
                    role: m.role === "assistant" ? "model" : "user",
                    parts: [{ text: m.content }],
                  })),
                  generationConfig: { maxOutputTokens: maxTokens, temperature: CHAT_TEMPERATURE },
                }),
              }
            );
            if (gRes.ok && gRes.body) {
              const reader = gRes.body.getReader();
              const dec = new TextDecoder();
              let buf = "", full = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let nl;
                while ((nl = buf.indexOf("\n")) !== -1) {
                  const line = buf.slice(0, nl).trim();
                  buf = buf.slice(nl + 1);
                  if (!line.startsWith("data:")) continue;
                  try {
                    const gd = JSON.parse(line.slice(5).trim());
                    const rawT = gd?.candidates?.[0]?.content?.parts?.[0]?.text;
                    const t = rawT == null ? "" : String(rawT);
                    if (t) { full += t; sse({ t }); }
                  } catch {}
                }
              }
              if (full) {
                track(env, ctx, { models: { "gemini-2.0-flash": 1 } });
                sse({ done: true, reply: full.trim() }); writer.close(); return;
              }
              attempts.push("gemini-stream: empty reply");
            } else {
              attempts.push("gemini-stream: http " + gRes.status);
            }
          } catch (err) {
            attempts.push("gemini-stream: " + (err && err.message ? err.message : String(err)));
          }
        }
        // Streaming failed for all models; try one plain (non-streaming) call before giving up.
        try {
          const fallback = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
            messages: withStyle(leanSystem),
            max_tokens: maxTokens,
            temperature: CHAT_TEMPERATURE,
          });
          const fb = ((fallback && (fallback.response || fallback.result)) || "")
            .replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
          if (fb) {
            track(env, ctx, { workersAiWins: 1, models: { "@cf/meta/llama-3.1-8b-instruct-fast (plain)": 1 } });
            sse({ done: true, reply: fb }); writer.close(); return;
          }
          attempts.push("plain-fallback: empty reply");
        } catch (err) {
          attempts.push("plain-fallback: " + (err && err.message ? err.message : String(err)));
        }
        // Groq fallback (same provider the non-streaming path uses) — the client's
        // chat mode often only succeeds because of this fallback, so voice mode
        // needs it too or it always ends up at the "resting" message below.
        // Streamed, so the first token reaches the user immediately instead of
        // arriving as one blob after the whole completion finishes.
        if (env.GROQ_API_KEY) {
          try {
            const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.GROQ_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: withStyle({ role: "system", content: leanSystem.content }),
                max_tokens: maxTokens,
                temperature: CHAT_TEMPERATURE,
                stream: true,
              }),
            });
            captureGroqLimits(env, ctx, groqRes);
            if (groqRes.ok && groqRes.body) {
              const reader = groqRes.body.getReader();
              const dec = new TextDecoder();
              let lineBuf = "", full = "";
              const stripThink = makeThinkFilter();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                lineBuf += dec.decode(value, { stream: true });
                let nl;
                while ((nl = lineBuf.indexOf("\n")) !== -1) {
                  const line = lineBuf.slice(0, nl).trim();
                  lineBuf = lineBuf.slice(nl + 1);
                  if (!line.startsWith("data:")) continue;
                  const payload = line.slice(5).trim();
                  if (payload === "[DONE]") continue;
                  try {
                    const rawT = JSON.parse(payload)?.choices?.[0]?.delta?.content;
                    const t = rawT == null ? "" : String(rawT);
                    if (t) {
                      full += t;
                      const visible = stripThink(t);
                      if (visible) sse({ t: visible });
                    }
                  } catch {}
                }
              }
              if (full) {
                track(env, ctx, { groqCalls: 1, models: { "groq/llama-3.3-70b-versatile": 1 } });
                sse({ done: true, reply: full.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() });
                writer.close(); return;
              }
              attempts.push("groq-stream: empty reply");
            } else {
              const rawText = await groqRes.text().catch(() => "");
              attempts.push(`groq-stream: http ${groqRes.status} | raw=${rawText.slice(0, 500)}`);
            }
          } catch (err) {
            attempts.push("groq-stream: " + (err && err.message ? err.message : String(err)));
          }
        }
        const detail = attempts.join(" | ");
        console.log("voice/stream chat fallback:", detail);
        track(env, ctx, { degradedReplies: 1 });
        sse({
          done: true,
          reply: "The assistant is taking a quick break \uD83D\uDE34. Please try again shortly \u2014 meanwhile you can sign up on the Register page or reach the organising committee.",
          degraded: true,
          // Staff only: this string carries upstream provider errors and model
          // ids, which anonymous visitors have no business seeing.
          detail: staff ? detail : undefined,
        });
        writer.close();
      })();

      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }

    const runModel = async (sys, model, tokens) => {
      const result = await env.AI.run(model, {
        messages: withStyle(sys),
        max_tokens: tokens,
        temperature: CHAT_TEMPERATURE,
      });
      let reply = ((result && (result.response || result.result)) || "").trim();
      // Some reasoning models wrap their thoughts in <think>...</think>; drop it.
      return reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    };

    // Collect what went wrong per model so the real reason is never lost - it is
    // logged (wrangler tail) AND returned in a `detail` field for debugging.
    const attempts = [];
    // 1) Normal attempt with the full prompt (including any fed knowledge).
    for (const model of models) {
      try {
        const reply = await runModel(fullSystem, model, maxTokens);
        if (reply) {
          track(env, ctx, { workersAiWins: 1, models: { [model]: 1 } });
          return json({ reply });
        }
        attempts.push(model + ": empty reply");
      } catch (err) {
        attempts.push(model + ": " + (err && err.message ? err.message : String(err)));
      }
    }
    // 2) Degraded retry: a large knowledge blob may have overflowed the context,
    //    so try again on the fast model WITHOUT the fed knowledge. This keeps the
    //    chatbot working no matter how much data was fed.
    try {
      const reply = await runModel(leanSystem, "@cf/meta/llama-3.1-8b-instruct-fast", 256);
      if (reply) {
        track(env, ctx, { workersAiWins: 1, models: { "@cf/meta/llama-3.1-8b-instruct-fast (lean)": 1 } });
        return json({ reply });
      }
      attempts.push("lean-retry: empty reply");
    } catch (err) {
      attempts.push("lean-retry: " + (err && err.message ? err.message : String(err)));
    }
    // 2b) Gemini fallback via direct API (requires GEMINI_API_KEY secret).
    //     Uses gemini-2.0-flash — fast, generous free tier, great personality.
    // if (env.GEMINI_API_KEY) {
    //   try {
    //     const geminiMessages = cleaned.map((m) => ({
    //       role: m.role === "assistant" ? "model" : "user",
    //       parts: [{ text: m.content }],
    //     }));
    //     const geminiRes = await fetch(
    //       `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`,
    //       {
    //         method: "POST",
    //         headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    //         body: JSON.stringify({
    //           system_instruction: { parts: [{ text: leanSystem.content }] },
    //           contents: geminiMessages,
    //           generationConfig: { maxOutputTokens: maxTokens },
    //         }),
    //       }
    //     );
    //     try {
    //       const rawText = await geminiRes.clone().text().catch(() => "");

    //       if (geminiRes.ok) {
    //         const gd = JSON.parse(rawText || "{}");

    //         const reply =
    //           gd?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    //         if (reply) return json({ reply });

    //         attempts.push(
    //           "gemini: empty reply | raw=" + rawText.slice(0, 500)
    //         );
    //       } else {
    //         attempts.push(
    //           `gemini: http ${geminiRes.status} | raw=${rawText}`
    //         );
    //         attempts.push(
    //           "gemini-url: " +
    //           `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${String(env.GEMINI_API_KEY).slice(0,8)}...`
    //         );
    //       }
    //     } catch (err) {
    //       attempts.push(
    //         "gemini: " + (err?.stack || err?.message || String(err))
    //       );
    //     }
    //   } catch (err) {
    //     attempts.push("gemini: " + (err && err.message ? err.message : String(err)));
    //   }
    // }
    // 2c) GROQ fallback via direct API (requires GROQ_API_KEY secret).
    if (env.GROQ_API_KEY) {
      try {
        const groqMessages = [
          {
            role: "system",
            content: leanSystem.content,
          },
          ...cleaned.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          styleReminder,
        ];

        const groqRes = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.GROQ_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "llama-3.3-70b-versatile",
              messages: groqMessages,
              max_tokens: maxTokens,
              temperature: CHAT_TEMPERATURE,
            }),
          }
        );

        captureGroqLimits(env, ctx, groqRes);
        const rawText = await groqRes.clone().text().catch(() => "");

        if (groqRes.ok) {
          const gd = JSON.parse(rawText || "{}");

          const reply =
            gd?.choices?.[0]?.message?.content?.trim();

          if (reply) {
            track(env, ctx, { groqCalls: 1, models: { "groq/llama-3.3-70b-versatile": 1 } });
            return json({ reply });
          }

          attempts.push(
            "groq: empty reply | raw=" + rawText.slice(0, 500)
          );
        } else {
          attempts.push(
            `groq: http ${groqRes.status} | raw=${rawText}`
          );
        }
        } catch (err) {
          attempts.push(
            "groq: " + (err?.stack || err?.message || String(err))
          );
        }
      }
    // 3) Everything failed -> a friendly "resting" reply (never a raw error) with
    //    a helpful alternative, returned as a normal message (HTTP 200). The real
    //    reason travels in `detail` so developers can see it in the console /
    //    Network tab without scaring end users.
    const detail = attempts.join(" | ");
    console.log("chat fallback:", detail);
    track(env, ctx, { degradedReplies: 1 });
    return json({
      reply:
        "I'm taking a quick break. Please try again shortly, or contact the organisers if you need urgent help.",
      degraded: true,
      // Staff only — see the streaming path above.
      detail: staff ? detail : undefined,
    });
  }

  // ---- Razorpay payment: create order ----
  if (resource === "payment" && parts[2] === "create-order" && method === "POST") {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      // Keys not configured yet — return a sentinel so the frontend can skip payment.
      return json({ skipped: true, reason: "Razorpay not configured" });
    }
    // The amount is looked up from the stored registration and NEVER taken
    // from the request. It used to come straight out of the body, so anyone
    // could create a ₹1 order for a ₹6000 booking and then have it verified
    // and marked paid.
    const { registrationId } = body;
    if (!registrationId) return json({ error: "registrationId required" }, 400);

    const regList = await loadList(env, "registrations");
    const reg = regList.find((r) => r.id === registrationId);
    if (!reg) return json({ error: "Registration not found" }, 404);
    if (reg.paid) return json({ error: "This registration is already paid." }, 409);

    const amount = Number(reg.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "This registration has no payable amount." }, 409);
    }

    const auth = btoa(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET);
    const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Authorization": "Basic " + auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // paise
        currency: "INR",
        receipt: String(registrationId).slice(0, 40),
        notes: { registrationId: String(registrationId) },
      }),
    });
    const rzpOrder = await rzpRes.json().catch(() => ({}));
    if (!rzpRes.ok) {
      return json({ error: rzpOrder.error?.description || "Razorpay order creation failed" }, 502);
    }

    // Remember which order belongs to which registration. Razorpay's signature
    // only covers orderId|paymentId — it says nothing about WHICH registration
    // the payment was for. Without this binding, someone could pay for their
    // own ₹1500 booking and then submit that same valid signature against a
    // ₹6000 registration to mark it paid.
    {
      const fresh = await loadList(env, "registrations");
      const idx = fresh.findIndex((r) => r.id === registrationId);
      if (idx !== -1) {
        fresh[idx].orderId = rzpOrder.id;
        fresh[idx].orderAmount = rzpOrder.amount;
        await saveList(env, "registrations", fresh);
      }
    }

    return json({
      orderId: rzpOrder.id,
      keyId: env.RAZORPAY_KEY_ID,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
    });
  }

  // ---- Razorpay payment: verify signature and mark paid ----
  if (resource === "payment" && parts[2] === "verify" && method === "POST") {
    const { registrationId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = body;
    if (!registrationId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return json({ error: "All payment fields required" }, 400);
    }
    if (!env.RAZORPAY_KEY_SECRET) return json({ error: "Razorpay not configured" }, 503);

    // Verify HMAC-SHA256 signature using the Web Crypto API (available in Workers).
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw", enc.encode(env.RAZORPAY_KEY_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(razorpayOrderId + "|" + razorpayPaymentId));
    const expected = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
    if (expected !== razorpaySignature) {
      return json({ error: "Payment signature mismatch — payment not verified." }, 400);
    }

    // Mark the registration as paid.
    const list = await loadList(env, "registrations");
    const idx = list.findIndex((r) => r.id === registrationId);
    if (idx === -1) return json({ error: "Registration not found" }, 404);

    // The signature above proves Razorpay processed THIS order — not that the
    // order belongs to THIS registration. Bind them, or a valid signature from
    // a cheap booking could be replayed against an expensive one.
    if (list[idx].orderId && list[idx].orderId !== razorpayOrderId) {
      return json({ error: "That payment does not belong to this registration." }, 409);
    }
    if (list[idx].paid) return json({ ok: true, registration: list[idx], already: true });

    list[idx].paid = true;
    list[idx].paymentId = razorpayPaymentId;
    list[idx].paidAt = new Date().toISOString();
    await saveList(env, "registrations", list);

    // Fire-and-forget: a WhatsApp outage (or an unapproved template) must never
    // turn a successful payment into a failed request. No-ops until the
    // WHATSAPP_* config is in place.
    ctx.waitUntil(waSendConfirmation(env, list[idx], url.origin));
    // The emailed ticket, paid flavour — same moment as the WhatsApp receipt.
    sendRegistrationEmail(env, ctx, list[idx], true);

    return json({ ok: true, registration: list[idx] });
  }

  // ---- Contact / email forwarding to support@biaac.com ----
  if (resource === "contact" && method === "POST") {
    const { name, email, subject, category, description } = body;
    if (!name || !email || !subject || !description) {
      return json({ error: "name, email, subject and description are required." }, 400);
    }
    const emailBody = [
      "New message from the Convention Helper contact form",
      "",
      "From    : " + name + " <" + email + ">",
      "Category: " + (category || "General"),
      "Subject : " + subject,
      "",
      description,
    ].join("\n");
    try {
      const mcRes = await fetch("https://api.mailchannels.net/tx/v1/send", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.MAILCHANNELS_API_KEY || "" },
        body: JSON.stringify({
          personalizations: [{
            to: [{ email: "support@biaac.com", name: "Convention Organising Committee" }],
            reply_to: { email: String(email).slice(0, 254), name: String(name).slice(0, 100) },
          }],
          from: { email: "noreply@biaac.com", name: "Convention Helper" },
          subject: "[" + (category || "General") + "] " + subject,
          content: [{ type: "text/plain", value: emailBody }],
        }),
      });
      if (mcRes.ok || mcRes.status === 202) return json({ ok: true });
      const errText = await mcRes.text().catch(() => "");
      return json({ error: "Email service error: " + mcRes.status, detail: errText }, 502);
    } catch (err) {
      return json({ error: "Failed to send: " + (err && err.message ? err.message : err) }, 502);
    }
  }

  // ---- Neural text-to-speech (Workers AI MeloTTS; no extra key needed) ----
  // The chat widget calls this for a natural voice, falling back to the
  // browser's built-in voice if this isn't available on the account.
  if (resource === "tts" && method === "POST") {
    if (!env.AI) return json({ error: "AI is not configured." }, 503);
    const text =
      (typeof body.text === "string" ? body.text : "").replace(/\s+/g, " ").trim().slice(0, 800);
    if (!text) return json({ error: "text required" }, 400);

    // Primary: Deepgram Aura-2 via direct API (requires DEEPGRAM_API_KEY secret).
    if (env.DEEPGRAM_API_KEY) {
      try {
        const response = await fetch(
          `https://api.deepgram.com/v1/speak?model=${env.DEEPGRAM_MODEL || "aura-2-amalthea-en"}`,
          {
            method: "POST",
            headers: {
              "Authorization": `Token ${env.DEEPGRAM_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ text }),
          }
        );
        if (response.ok) {
          // Convert to base64 so the client gets the same {audio} JSON format as MeloTTS.
          const buf = await response.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = "";
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
          track(env, ctx, { ttsCalls: 1, ttsChars: text.length });
          return json({ audio: btoa(binary) });
        }
        // Non-OK response falls through to MeloTTS fallback below.
      } catch (_) {
        // Network/parse error — fall through to MeloTTS.
      }
    }

    // Fallback: Cloudflare Workers AI MeloTTS (free, no key needed).
    try {
      const res = await env.AI.run("@cf/myshell-ai/melotts", { prompt: text, lang: "en" });
      const audio = res && res.audio ? res.audio : null;
      if (!audio) return json({ error: "no audio produced" }, 502);
      track(env, ctx, { ttsCalls: 1, ttsChars: text.length, melo: 1 });
      return json({ audio });
    } catch (err) {
      return json(
        { error: "tts failed: " + (err && err.message ? err.message : "unknown") },
        502
      );
    }
  }

  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // WhatsApp webhook is handled ahead of handleApi because the signature
    // check needs the raw body, which handleApi would consume as JSON.
    // Trailing slash tolerated - Meta keeps whatever URL was pasted in, and a
    // stray "/" would otherwise fall through to the static asset handler.
    if (url.pathname.replace(/\/+$/, "") === "/api/whatsapp/webhook") {
      try {
        return await handleWhatsAppWebhook(request, env, ctx);
      } catch (err) {
        console.log("whatsapp webhook error:", err && err.message, err && err.stack);
        return new Response("ok"); // never make Meta retry because of our own bug
      }
    }

    // API requests go to the backend.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return withSecurityHeaders(await handleApi(request, env, ctx), env, url);
      } catch (err) {
        // Log the real reason; return an opaque id. The detail used to be sent
        // to the client, which leaked internal messages and upstream provider
        // error bodies to anonymous callers.
        const detail = err && err.message ? err.message : String(err);
        const requestId = crypto.randomUUID().slice(0, 8);
        console.log("handleApi error [" + requestId + "]:", detail, err && err.stack);
        return withSecurityHeaders(
          json({ error: "Something went wrong on our side.", requestId }, 500),
          env,
          url
        );
      }
    }

    // /p/<slug> is GONE. It served model-generated HTML from this origin,
    // which gave any published page the signed-in staff member's cookies and
    // full same-origin access to the admin API. See the note where the
    // /api/pages routes used to be.

    // ---- Server-side page protection -----------------------------------
    // The real boundary for the admin screens. Client-side gating only ever
    // hid the UI; the HTML and its data were always fetchable.
    const page = canonicalPage(url.pathname);
    if (page === null) {
      return new Response("Bad request.", { status: 400 });
    }

    const needed = PROTECTED_PAGES[page];
    if (needed) {
      const s = await readSession(request, env);

      if (!s) {
        const next = safeNext(page + url.search);
        return redirectTo(
          authOrigin(env, request) + "/login.html?next=" + encodeURIComponent(next)
        );
      }
      if (!roleAtLeast(s.staff.role, needed)) {
        audit(env, ctx, auditFrom(request, {
          type: "authz_deny",
          staffId: s.staff.id,
          email: s.staff.email,
          outcome: "deny",
          detail: page + " needs " + needed,
        }));
        return redirectTo(authOrigin(env, request) + "/403.html?need=" + encodeURIComponent(needed));
      }

      // ASSETS returns an immutable Response, so rebuild it to add headers.
      // no-store matters: without it the browser back button after sign-out
      // still shows the previous occupant's attendee list.
      const assetRes = await env.ASSETS.fetch(request);
      const out = new Response(assetRes.body, assetRes);
      out.headers.set("cache-control", "private, no-store, max-age=0, must-revalidate");
      out.headers.set("vary", "Cookie");
      return withSecurityHeaders(out, env, url);
    }

    // Everything else is served from the static site (public/).
    return withSecurityHeaders(await env.ASSETS.fetch(request), env, url);
  },

  // A single cron ticks every 10 minutes; runSchedules decides what's due —
  // the daily digest at the configured IST time, the critical check every 6h.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedules(env));
  },
};

// Cloudflare Worker - serves the static site (public/) AND the /api/* backend.
// Storage: one KV namespace bound as CONVENTION_KV (configured in wrangler.toml).
// Static files are served through the ASSETS binding (also in wrangler.toml).

const PRICING = [
  {
    id: "without-stay",
    name: "Without Stay",
    description: "Full convention access. Accommodation not included.",
    price: 1500,
  },
  {
    id: "single-sharing",
    name: "With Stay - Single Sharing",
    description: "Private room for one. All meals & sessions included.",
    price: 6000,
  },
  {
    id: "double-sharing",
    name: "With Stay - Double Sharing",
    description: "Room shared by two. All meals & sessions included.",
    price: 4200,
  },
  {
    id: "triple-sharing",
    name: "With Stay - Triple Sharing",
    description: "Room shared by three. All meals & sessions included.",
    price: 3200,
  },
];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const findCategory = (id) => PRICING.find((c) => c.id === id);

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

// A request is "developer" only if it carries the exact DEV_KEY secret.
function isDeveloper(request, env, body) {
  const key =
    (body && typeof body.devKey === "string" && body.devKey) ||
    request.headers.get("x-dev-key") ||
    "";
  return Boolean(env.DEV_KEY) && key.length > 0 && key === env.DEV_KEY;
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

async function sendOpsEmail(env, subject, html) {
  if (!env.DASHBOARD_EMAIL) return { ok: false, note: "DASHBOARD_EMAIL not set" };
  try {
    const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.MAILCHANNELS_API_KEY || "" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: env.DASHBOARD_EMAIL, name: "Convention Ops" }] }],
        from: { email: "noreply@biaac.com", name: "Convention Ops Dashboard" },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
    });
    return { ok: res.ok || res.status === 202, note: "http " + res.status };
  } catch (e) {
    return { ok: false, note: e && e.message ? e.message : String(e) };
  }
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
  const today = new Date().toISOString().slice(0, 10);
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

  let body = {};
  if (method === "POST" || method === "PATCH") {
    body = await request.json().catch(() => ({}));
  }

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
        if (!isDeveloper(request, env, body)) return json({ error: "Forbidden" }, 403);
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

    if (method === "POST" && !id) {
      if (!isDeveloper(request, env, body)) return json({ error: "Forbidden" }, 403);
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
      if (!isDeveloper(request, env, body)) return json({ error: "Forbidden" }, 403);
      return json(await runReflectionBroadcast(env));
    }

    if (method === "DELETE" && id) {
      if (!isDeveloper(request, env, body)) return json({ error: "Forbidden" }, 403);
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
      const record = {
        id: crypto.randomUUID(),
        name,
        email,
        phone,
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
      return json(record, 201);
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
        date: body.date || new Date().toISOString().slice(0, 10),
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

  // ---- Developer key verification ----
  if (resource === "dev" && parts[2] === "verify" && method === "POST") {
    return json({ ok: isDeveloper(request, env, body) });
  }

  // ---- Ops dashboard: preview in browser / send now (developer-gated) ----
  // GET  /api/report/preview?devKey=...  → the digest HTML, rendered live
  // POST /api/report/send                → email the daily digest right now
  // POST /api/report/check               → run the critical check right now
  if (resource === "report") {
    const qKey = url.searchParams.get("devKey") || "";
    const authed =
      isDeveloper(request, env, body) || (Boolean(env.DEV_KEY) && qKey === env.DEV_KEY);
    if (!authed) return json({ error: "Developer key required." }, 403);
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
      if (!isDeveloper(request, env, body)) {
        return json({ error: "Developer key required." }, 403);
      }
      const title = (body.title || "").trim() || "Untitled note";
      const text = typeof body.content === "string" ? body.content.trim() : "";
      if (!text) return json({ error: "Some text content is required." }, 400);
      const rid = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.CONVENTION_DB.prepare(
        "INSERT INTO knowledge (id, title, content, created_at) VALUES (?, ?, ?, ?)"
      )
        .bind(rid, title.slice(0, 120), text.slice(0, 20000), now)
        .run();
      return json({ ok: true, id: rid }, 201);
    }

    if (method === "DELETE" && id) {
      if (!isDeveloper(request, env, body)) {
        return json({ error: "Developer key required." }, 403);
      }
      await env.CONVENTION_DB.prepare("DELETE FROM knowledge WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
  }

  // ---- Pages (developer-generated, stored in D1) ----
  if (resource === "pages") {
    if (!env.CONVENTION_DB) {
      return json(
        { error: "D1 database 'CONVENTION_DB' is not bound. Add it in wrangler.toml or Worker settings." },
        500
      );
    }
    await ensurePagesTable(env);

    if (method === "GET" && !id) {
      const { results } = await env.CONVENTION_DB.prepare(
        "SELECT slug, title, created_at, updated_at FROM pages ORDER BY updated_at DESC"
      ).all();
      return json(results || []);
    }

    if (method === "GET" && id) {
      const row = await env.CONVENTION_DB.prepare(
        "SELECT slug, title, html, created_at, updated_at FROM pages WHERE slug = ?"
      )
        .bind(id)
        .first();
      if (!row) return json({ error: "Not found." }, 404);
      return json(row);
    }

    if (method === "POST" && !id) {
      if (!isDeveloper(request, env, body)) {
        return json({ error: "Developer key required." }, 403);
      }
      const slug = slugify(body.slug || body.title);
      const title = (body.title || "").trim() || slug;
      const html = typeof body.html === "string" ? body.html : "";
      if (!slug || !html.trim()) {
        return json({ error: "A slug/title and non-empty html are required." }, 400);
      }
      const now = new Date().toISOString();
      await env.CONVENTION_DB.prepare(
        "INSERT INTO pages (slug, title, html, created_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(slug) DO UPDATE SET title = excluded.title, html = excluded.html, updated_at = excluded.updated_at"
      )
        .bind(slug, title, html, now, now)
        .run();
      return json({ ok: true, slug, title, url: "/p/" + slug }, 201);
    }

    if (method === "DELETE" && id) {
      if (!isDeveloper(request, env, body)) {
        return json({ error: "Developer key required." }, 403);
      }
      await env.CONVENTION_DB.prepare("DELETE FROM pages WHERE slug = ?").bind(id).run();
      return json({ ok: true });
    }
  }

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

    // Role is claimed by the client for reading; developer powers additionally
    // require the DEV_KEY secret (verified by isDeveloper) before any action runs.
    const dev = isDeveloper(request, env, body);
    const staff = dev || body.role === "admin";
    // Voice mode: the user is listening, so we keep answers short and snappy so
    // the neural TTS returns quickly and there is far less to wait for.
    const voice = body.voice === true;
    track(env, ctx, { chatRequests: 1, voiceChats: voice ? 1 : 0 });

    const priceLines = PRICING.map(
      (c) => `- ${c.name}: \u20b9${c.price} (${c.description})`
    ).join("\n");

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
        "Q: 'How much does it cost?' → YOU SAY: 'four options: ₹1500 (no stay), ₹3200 triple sharing, ₹4200 double, ₹6000 solo room. meals included in all of them ngl. which one's calling your name?'",
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
        "== WHAT YOU KNOW (reference material — deliver it in YOUR voice, never formally) ==",
        "- Dates: 9th to 11th July 2027. Location: Bangalore, India.",
        "- Anyone in recovery is welcome. Even non members are welcome.",
        "- Registration categories and prices:",
        priceLines,
        "- Meals (breakfast, lunch, dinner, tea breaks) and all sessions included in every stay category.",
        "- 'Without Stay' = full convention access, no accommodation.",
        "- To register: Register page on this site, or I can book it right here in this chat.",
        "",
        "== WHAT YOU DON'T KNOW (say this briefly and pivot — never dwell on it) ==",
        "You don't know the exact venue address, schedule, speaker names, travel directions, refund policy, or phone numbers UNLESS they appear in the 'EXTRA KNOWLEDGE' section below. If not there, say 'not confirmed yet, will be shared with registered guests' and immediately offer something you CAN do. Never invent specifics.",
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

    // Decide early whether this is a page-building request (developers only).
    const wantsPage =
      dev &&
      /\b(page|redesign|re-?design|build|design|create|layout|website|landing|section|banner|template|edit the|update the)\b/.test(
        lastUserMsg.toLowerCase()
      );

    // Staff (admin/developer) get live figures so they can ask about numbers.
    if (staff) {
      content.push(
        "",
        await buildDataSummary(env),
        "When staff ask about numbers, answer directly and precisely from the LIVE EVENT DATA above, and answer ONLY the specific thing they asked about: a question about expenses, expenditure or spending gets expense figures only; a question about registrations or sign-ups gets registration figures only; a question about money collected or pending gets those figures only. Never mix registration details into an expense answer or expense details into a registration answer. Present money with the \u20b9 symbol."
      );
    }

    // Developers get page-building superpowers, gated by the verified DEV_KEY.
    if (dev) {
      let pageList = "none yet";
      try {
        if (env.CONVENTION_DB) {
          await ensurePagesTable(env);
          const { results } = await env.CONVENTION_DB.prepare(
            "SELECT slug, title FROM pages ORDER BY updated_at DESC LIMIT 30"
          ).all();
          if (results && results.length) {
            pageList = results.map((p) => `${p.slug} ("${p.title}")`).join(", ");
          }
        }
      } catch (e) {
        /* ignore listing errors */
      }
      content.push(
        "",
        "== DEVELOPER MODE (this user is a verified developer) ==",
        "IMPORTANT: You ARE a page-building agent for this developer right now. You CAN and DO create, edit and delete real pages that publish live to this website. NEVER say you cannot build pages, cannot design UI, or that you are 'just a chat assistant' - that is false for this user. When they ask, actually build it.",
        "You can BUILD and EDIT full web pages for this site. Existing pages: " + pageList + ".",
        "When the developer asks you to create, design, build, redesign or edit a page, do this:",
        "1) Write a short friendly one-line message describing what you made.",
        "2) On a new line put the marker [[ACTION]] then single-line JSON: " +
          '{"action":"create_page","slug":"short-kebab-slug","title":"Human Title"}. Use "update_page" instead of "create_page" when editing an existing slug.',
        "3) On the next line put the marker [[HTML]] and then the COMPLETE HTML document. Everything after [[HTML]] until the end of your reply is the page source.",
        "HTML RULES: start with <!doctype html>; include <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">; put all CSS in an inline <style> block and any JS in inline <script>; make it responsive and visually polished; you MAY fetch live data from /api/dashboard, /api/registrations, /api/expenses or /api/pricing to render real numbers. Do NOT wrap the HTML in markdown code fences. Never mention the markers to the user.",
        'To delete a page, reply with a short message then [[ACTION]]{"action":"delete_page","slug":"the-slug"} (no [[HTML]] needed).',
        "For non-page questions, behave normally and do not emit page markers."
      );
    }

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

    // Only actual page-building work needs the heavy HTML model + big token
    // budget. Everything else (data questions, normal chat) uses the fast
    // model so replies come back quickly.
    let models;
    let maxTokens;
    if (wantsPage) {
      // Full HTML/CSS/JS generation - quality first, with fallbacks.
      models = [
        "@cf/zai-org/glm-5.2",
        "@cf/moonshotai/kimi-k2.7-code",
        "@cf/zai-org/glm-4.7-flash",
        "@cf/meta/llama-3.1-8b-instruct-fast",
      ];
      maxTokens = 3500;
    } else {
      models = ["@cf/meta/llama-3.1-8b-instruct-fast", "@cf/zai-org/glm-4.7-flash"];
      maxTokens = voice ? 170 : staff ? 340 : 280;
    }

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
              messages: [fullSystem, ...cleaned],
              max_tokens: maxTokens,
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
                  const t = JSON.parse(payload).response || "";
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
                  system_instruction: { parts: [{ text: leanSystem.content }] },
                  contents: cleaned.map((m) => ({
                    role: m.role === "assistant" ? "model" : "user",
                    parts: [{ text: m.content }],
                  })),
                  generationConfig: { maxOutputTokens: maxTokens },
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
                    const t = gd?.candidates?.[0]?.content?.parts?.[0]?.text || "";
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
            messages: [leanSystem, ...cleaned],
            max_tokens: maxTokens,
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
                messages: [{ role: "system", content: leanSystem.content }, ...cleaned],
                max_tokens: maxTokens,
                temperature: 0.7,
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
                    const t = JSON.parse(payload)?.choices?.[0]?.delta?.content || "";
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
          detail,
        });
        writer.close();
      })();

      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }

    const runModel = async (sys, model, tokens) => {
      const result = await env.AI.run(model, {
        messages: [sys, ...cleaned],
        max_tokens: tokens,
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
              temperature: 0.7,
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
      detail,
    });
  }

  // ---- Razorpay payment: create order ----
  if (resource === "payment" && parts[2] === "create-order" && method === "POST") {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      // Keys not configured yet — return a sentinel so the frontend can skip payment.
      return json({ skipped: true, reason: "Razorpay not configured" });
    }
    const { registrationId, amount } = body;
    if (!registrationId || !amount) return json({ error: "registrationId and amount required" }, 400);
    const auth = btoa(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET);
    const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Authorization": "Basic " + auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Math.round(Number(amount) * 100), // paise
        currency: "INR",
        receipt: String(registrationId).slice(0, 40),
        notes: { registrationId: String(registrationId) },
      }),
    });
    const rzpOrder = await rzpRes.json().catch(() => ({}));
    if (!rzpRes.ok) {
      return json({ error: rzpOrder.error?.description || "Razorpay order creation failed" }, 502);
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
    list[idx].paid = true;
    list[idx].paymentId = razorpayPaymentId;
    list[idx].paidAt = new Date().toISOString();
    await saveList(env, "registrations", list);

    // Fire-and-forget: a WhatsApp outage (or an unapproved template) must never
    // turn a successful payment into a failed request. No-ops until the
    // WHATSAPP_* config is in place.
    ctx.waitUntil(waSendConfirmation(env, list[idx], url.origin));

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
        return await handleApi(request, env, ctx);
      } catch (err) {
        // Never let the backend crash into a blank 500 - surface the real reason
        // as JSON so it shows up in the browser console / Network tab.
        const detail = err && err.message ? err.message : String(err);
        console.log("handleApi error:", detail, err && err.stack);
        return json({ error: "Server error", detail }, 500);
      }
    }

    // Developer-generated pages, served live from D1 at /p/<slug>.
    if (url.pathname.startsWith("/p/")) {
      const slug = decodeURIComponent(url.pathname.slice(3)).replace(/\/+$/, "");
      if (env.CONVENTION_DB && slug) {
        try {
          await ensurePagesTable(env);
          const row = await env.CONVENTION_DB.prepare(
            "SELECT html FROM pages WHERE slug = ?"
          )
            .bind(slug)
            .first();
          if (row && row.html) {
            return new Response(row.html, {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }
        } catch (e) {
          /* fall through to 404 */
        }
      }
      return new Response("Page not found.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Everything else is served from the static site (public/).
    return env.ASSETS.fetch(request);
  },

  // A single cron ticks every 10 minutes; runSchedules decides what's due —
  // the daily digest at the configured IST time, the critical check every 6h.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedules(env));
  },
};

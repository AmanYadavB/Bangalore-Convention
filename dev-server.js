// Local dev server — emulates the Worker's API surface so the whole site
// (including auth, voice mode and streaming chat) can be tested WITHOUT
// Cloudflare. Wrangler now requires Node 22+, but this runs on Node 18+.
//
//   npm start                     → http://localhost:8787
//
// What works locally:
//   • Static site from public/, with the same server-side page gate as the Worker
//   • Full auth: password login, magic links (printed to THIS CONSOLE instead of
//     emailed), and Google SSO if GOOGLE_CLIENT_ID/SECRET are set
//   • POST /api/chat  — real Groq streaming when GROQ_API_KEY is set (env or
//     wrangler.toml [vars]); otherwise a canned reply streamed word-by-word so
//     the streaming UI and voice visualizer can still be exercised offline.
//   • POST /api/tts   — proxied to Deepgram using DEEPGRAM_API_KEY from
//     wrangler.toml [vars] or the environment; 503 without a key (the client
//     then falls back to the browser voice).
//   • pricing, registrations, expenses, dashboard, reflections, knowledge and
//     the ops report endpoints — all from in-memory data, nothing persisted.
// Not emulated: Razorpay (returns {skipped}), real email delivery.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, "public");

// ---- Pull vars out of wrangler.toml so real keys work locally --------------
// .dev.vars (gitignored) is read second and wins, so local-only secrets never
// have to be pasted into the tracked wrangler.toml.
const VARS = {};
function loadVarsFrom(file, sectionSplit) {
  try {
    let text = fs.readFileSync(path.join(__dirname, file), "utf8");
    if (sectionSplit) text = text.split(sectionSplit)[1] || "";
    for (const m of text.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n\r]*)"?/gm)) {
      VARS[m[1]] = m[2].trim();
    }
  } catch (e) {
    /* file absent — that's fine */
  }
}
loadVarsFrom("wrangler.toml", /\[vars\]/);
loadVarsFrom(".dev.vars", null);

const key = (name) => process.env[name] || VARS[name] || "";

// Loaded from shared/pricing.mjs + shared/facts.mjs during bootstrap(),
// before the server listens.
let PRICING = [];
let pricingPromptLine = () => "";
let factsPromptBlock = () => "";
let groundingRuleBlock = () => "";
// shared/qr.mjs, loaded in bootstrap() — the same renderer the Worker uses, so
// the ticket QR and the downloadable ticket can be exercised locally too.
let qrPng = null;
let qrSvg = null;

// In-memory data so the flows can be clicked through locally.
const registrations = [];
const expenses = [];
const reflections = [];
const knowledge = [];
let devDigestTime = "";

// IST date, matching the Worker's istDate(). Dates default to IST rather than
// UTC so an evening entry doesn't land on the previous day.
const istDate = () =>
  new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const json = (res, obj, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });

// ---- Canned chat replies (offline mode) ------------------------------------
function cannedReply(lastMsg) {
  const q = String(lastMsg || "").toLowerCase();
  if (/date|when|july/.test(q))
    return "July 9th to 11th bro, three full days in Bangalore! you planning to come?";
  if (/price|cost|much|fee/.test(q))
    return pricingPromptLine().replace(/^Prices: /, "options: ") + " which one's calling your name?";
  if (/register|book|sign/.test(q))
    return "two ways — hit the Register page, or just tell me your details and I'll book it for you rn. which works?";
  if (/venue|where|place/.test(q))
    return "ngl venue isn't confirmed yet, will be shared with registered guests — but Bangalore is the city fr. want me to help you get a spot first?";
  if (/hi|hello|hey|yo\b/.test(q))
    return "heyyy! I've been folded inside this button waiting for someone to talk to. ask me anything about the convention fr";
  return "local dev mode here — I'm a canned reply since no GROQ_API_KEY is set, but the streaming and voice UI you're testing is 100% real. ask about dates, prices, or registering!";
}

// Stream words over SSE with small delays so streaming UI/voice viz is visible.
function streamCanned(res, reply) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const words = reply.split(" ");
  let i = 0;
  const tick = setInterval(() => {
    if (i < words.length) {
      res.write("data: " + JSON.stringify({ t: words[i] + (i < words.length - 1 ? " " : "") }) + "\n\n");
      i++;
    } else {
      clearInterval(tick);
      res.write("data: " + JSON.stringify({ done: true, reply }) + "\n\n");
      res.end();
    }
  }, 55);
}

// ---- Groq streaming (when a key is available) ------------------------------
async function streamGroq(res, messages, voice) {
  const system = [
    "You are a tiny chaotic warm Gen-Z mascot for the Bangalore Convention 2027 (an AA convention, 9-11 July 2027, Bangalore).",
    pricingPromptLine(),
    factsPromptBlock(),
    groundingRuleBlock(),
    voice ? "VOICE MODE: answer in 1 short spoken sentence (about 20 words). No lists, no emojis." : "Keep replies to 1-3 short punchy sentences.",
  ].join("\n");
  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key("GROQ_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: voice ? 170 : 280,
      temperature: 0.4,
      stream: true,
    }),
  });
  if (!groqRes.ok || !groqRes.body) throw new Error("groq http " + groqRes.status);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const reader = groqRes.body.getReader();
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
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const t = JSON.parse(payload)?.choices?.[0]?.delta?.content || "";
        if (t) {
          full += t;
          res.write("data: " + JSON.stringify({ t }) + "\n\n");
        }
      } catch {}
    }
  }
  res.write("data: " + JSON.stringify({ done: true, reply: full.trim() }) + "\n\n");
  res.end();
}

// ---- Request handling -------------------------------------------------------
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", resource, id]
  const resource = parts[1];
  const id = parts[2];
  const body = req.method === "POST" || req.method === "PATCH" ? await readBody(req) : {};

  // ---- Auth, faked ----
  // The real Worker gates every staff page behind a D1 session. Locally there
  // is no D1, so /api/auth/me used to 404 — which made requireUser() return
  // null and the staff pages (check-in included) attach no handlers at all and
  // sit there looking functional. A standing developer session keeps local dev
  // honest to what a signed-in committee member actually sees.
  if (resource === "auth" && parts[2] === "me") {
    return json(res, {
      authenticated: true,
      sessionMethod: "dev",
      user: { id: "dev", email: "dev@localhost", name: "Local Developer", role: "developer" },
    });
  }
  if (resource === "auth" && parts[2] === "logout") return json(res, { ok: true });

  if (resource === "pricing") return json(res, PRICING);

  if (resource === "chat" && req.method === "POST") {
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const cleaned = incoming
      .filter((m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    const lastUser = [...cleaned].reverse().find((m) => m.role === "user");
    const reply = cannedReply(lastUser && lastUser.content);
    if (body.stream === true) {
      if (key("GROQ_API_KEY")) {
        try {
          return await streamGroq(res, cleaned, body.voice === true);
        } catch (e) {
          console.log("[dev] groq failed, using canned reply:", e.message);
        }
      }
      return streamCanned(res, reply);
    }
    return json(res, { reply });
  }

  if (resource === "tts" && req.method === "POST") {
    const text = (typeof body.text === "string" ? body.text : "").replace(/\s+/g, " ").trim().slice(0, 800);
    if (!text) return json(res, { error: "text required" }, 400);
    const dgKey = key("DEEPGRAM_API_KEY");
    if (!dgKey) return json(res, { error: "no TTS key locally" }, 503);
    try {
      const dg = await fetch(
        `https://api.deepgram.com/v1/speak?model=${key("DEEPGRAM_MODEL") || "aura-2-amalthea-en"}`,
        {
          method: "POST",
          headers: { Authorization: `Token ${dgKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        }
      );
      if (!dg.ok) return json(res, { error: "deepgram http " + dg.status }, 502);
      const buf = Buffer.from(await dg.arrayBuffer());
      return json(res, { audio: buf.toString("base64") });
    } catch (e) {
      return json(res, { error: "tts failed: " + e.message }, 502);
    }
  }

  // GET /api/ticket/:code/qr.png|qr.svg — same contract as the Worker's, so
  // the confirmation QR and the downloadable ticket both work offline.
  if (resource === "ticket" && id && req.method === "GET") {
    const reg = registrations.find((r) => r.ticketCode === id);
    if (!reg) return json(res, { error: "Unknown ticket." }, 404);
    const payload = `http://localhost:${PORT}/checkin.html#` + reg.ticketCode;
    const scale = Math.min(20, Math.max(2, Math.round(Number(url.searchParams.get("s")) || 8)));
    const svg = String(parts[3] || "qr.png").toLowerCase() === "qr.svg";
    const out = svg ? Buffer.from(qrSvg(payload, scale, 4)) : Buffer.from(qrPng(payload, scale, 4));
    res.writeHead(200, {
      "content-type": svg ? "image/svg+xml; charset=utf-8" : "image/png",
      "content-length": out.length,
      "cache-control": "private, max-age=86400",
    });
    return res.end(out);
  }

  // ---- Check-in ----
  // Mirrors the Worker's decision logic so the door screen can actually be
  // exercised with `npm run dev`. The date window is off here for the same
  // reason it is off in the Worker right now: nothing is testable if every
  // ticket answers "not yet" for the next year.
  if (resource === "checkin" && req.method === "POST") {
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) return json(res, { error: "No ticket code." }, 400);
    const reg = registrations.find(
      (r) => String(r.ticketCode || "").toUpperCase() === code
    );
    if (!reg) return json(res, { status: "invalid", message: "Not a ticket we issued." });

    const who = { name: reg.name, category: reg.categoryName, ticketCode: reg.ticketCode };
    if (!reg.paid)
      return json(res, { status: "unpaid", message: "This registration was never paid.", ...who });
    if (reg.checkedInAt)
      return json(res, { status: "already", message: "Already checked in.", at: reg.checkedInAt, ...who });

    reg.checkedInAt = new Date().toISOString();
    reg.checkedInBy = "dev@localhost";
    return json(res, { status: "ok", message: "Welcome in.", at: reg.checkedInAt, ...who });
  }

  if (resource === "registrations") {
    if (req.method === "GET") return json(res, registrations);
    if (req.method === "POST") {
      const cat = PRICING.find((c) => c.id === body.categoryId);
      if (!body.name || !body.email || !body.phone || !cat)
        return json(res, { error: "Name, email, phone and a valid category are required." }, 400);
      const record = {
        id: "local-" + Date.now(),
        name: body.name, email: body.email, phone: body.phone,
        city: body.city || "", gender: body.gender || "", notes: body.notes || "",
        categoryId: cat.id, categoryName: cat.name, amount: cat.price,
        paid: false, createdAt: new Date().toISOString(),
        ticketCode: devTicketCode(),
      };
      registrations.push(record);
      return json(res, record, 201);
    }
    if (req.method === "PATCH" && id) {
      const item = registrations.find((r) => r.id === id);
      if (!item) return json(res, { error: "Not found." }, 404);
      if (typeof body.paid === "boolean") item.paid = body.paid;
      return json(res, item);
    }
    if (req.method === "DELETE" && id) {
      const i = registrations.findIndex((r) => r.id === id);
      if (i === -1) return json(res, { error: "Not found." }, 404);
      registrations.splice(i, 1);
      return json(res, { ok: true });
    }
  }

  // Previously this returned the array for EVERY method, so a POST looked like
  // it succeeded (the page toasted "Expense added") while nothing was created.
  if (resource === "expenses") {
    if (req.method === "GET") return json(res, expenses);
    if (req.method === "POST") {
      const amount = Number(body.amount);
      if (!body.title || !Number.isFinite(amount) || amount <= 0)
        return json(res, { error: "A title and a positive amount are required." }, 400);
      const record = {
        id: "local-" + Date.now(),
        title: String(body.title).trim(),
        category: (body.category || "General").trim(),
        amount,
        date: body.date || istDate(),
        notes: (body.notes || "").trim(),
        createdAt: new Date().toISOString(),
      };
      expenses.push(record);
      return json(res, record, 201);
    }
    if (req.method === "DELETE" && id) {
      const i = expenses.findIndex((e) => e.id === id);
      if (i === -1) return json(res, { error: "Not found." }, 404);
      expenses.splice(i, 1);
      return json(res, { ok: true });
    }
    return json(res, { error: "Unsupported method" }, 405);
  }

  if (resource === "reflections") {
    if (parts[3] === "image") {
      if (req.method === "GET") return json(res, { error: "No image for this reflection" }, 404);
      if (req.method === "POST") {
        const item = reflections.find((r) => r.id === id);
        if (item) item.hasImage = true;
        return json(res, { ok: true, bytes: 0, note: "not stored in dev" });
      }
      return json(res, { error: "Unsupported method" }, 405);
    }
    if (req.method === "GET" && !id) {
      const items = [...reflections].sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return json(res, { channelUrl: key("WHATSAPP_CHANNEL_URL"), items });
    }
    if (req.method === "GET" && id) {
      const item = reflections.find((r) => r.id === id);
      return item ? json(res, item) : json(res, { error: "Not found" }, 404);
    }
    if (req.method === "POST" && id === "send") {
      console.log("  [dev] reflection broadcast requested (no messages actually sent)");
      return json(res, { ok: true, sent: 0, note: "dev server does not send WhatsApp messages" });
    }
    if (req.method === "POST" && !id) {
      const text = (body.body || "").trim();
      if (!text) return json(res, { error: "Reflection text is required." }, 400);
      const record = {
        id: "local-" + Date.now(),
        date: (body.date || istDate()).slice(0, 10),
        title: (body.title || "").trim(),
        body: text,
        createdAt: new Date().toISOString(),
      };
      reflections.push(record);
      return json(res, record, 201);
    }
    if (req.method === "DELETE" && id) {
      const i = reflections.findIndex((r) => r.id === id);
      if (i === -1) return json(res, { error: "Not found" }, 404);
      reflections.splice(i, 1);
      return json(res, { ok: true });
    }
    return json(res, { error: "Unsupported method" }, 405);
  }

  if (resource === "knowledge") {
    if (req.method === "GET")
      return json(res, knowledge.map((k) => ({
        id: k.id, title: k.title, preview: k.content.slice(0, 200),
        chars: k.content.length, createdAt: k.createdAt,
      })));
    if (req.method === "POST") {
      const content = (body.content || "").trim();
      if (!content) return json(res, { error: "Content is required." }, 400);
      const stored = content.slice(0, 20000);
      const record = {
        id: "local-" + Date.now(),
        title: (body.title || "Untitled").trim().slice(0, 120),
        content: stored,
        createdAt: new Date().toISOString(),
      };
      knowledge.push(record);
      return json(res, { ...record, truncated: stored.length < content.length, storedChars: stored.length }, 201);
    }
    if (req.method === "DELETE" && id) {
      const i = knowledge.findIndex((k) => k.id === id);
      if (i === -1) return json(res, { error: "Not found" }, 404);
      knowledge.splice(i, 1);
      return json(res, { ok: true });
    }
    return json(res, { error: "Unsupported method" }, 405);
  }

  if (resource === "dashboard") {
    const paid = registrations.filter((r) => r.paid);
    const totalPledged = registrations.reduce((s, r) => s + r.amount, 0);
    const totalCollected = paid.reduce((s, r) => s + r.amount, 0);
    const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
    const expenseCats = [...new Set(expenses.map((e) => e.category))];
    return json(res, {
      registrationCount: registrations.length,
      paidCount: paid.length,
      totalPledged,
      totalCollected,
      totalPending: totalPledged - totalCollected,
      totalExpenses,
      balance: totalCollected - totalExpenses,
      byCategory: PRICING.map((c) => ({
        id: c.id, name: c.name,
        count: registrations.filter((r) => r.categoryId === c.id).length,
        amount: registrations.filter((r) => r.categoryId === c.id).reduce((s, r) => s + r.amount, 0),
      })),
      expenseByCategory: expenseCats.map((name) => ({
        name,
        amount: expenses.filter((e) => e.category === name).reduce((s, e) => s + e.amount, 0),
      })),
    });
  }

  // Ops report endpoints — stubs, but present so ops.html is not a wall of 404s.
  if (resource === "report") {
    const action = parts[2];
    if (action === "status")
      return json(res, {
        nowIst: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " "),
        digestTime: devDigestTime || key("DIGEST_TIME_IST") || "17:00",
        digestSource: devDigestTime ? "KV override (dev)" : "wrangler.toml",
        digestAlreadySentToday: false,
        dashboardEmail: key("DASHBOARD_EMAIL"),
        note: "dev server — nothing is actually scheduled or emailed",
      });
    if (action === "preview") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<h1>Ops digest preview</h1><p>Dev server stub — the real digest is built in worker.js.</p>");
    }
    if (action === "send" || action === "check")
      return json(res, { ok: true, note: "dev server — no email sent" });
    if (action === "reset") return json(res, { ok: true, cleared: true });
    if (action === "schedule") {
      if (req.method === "GET") return json(res, { time: devDigestTime || key("DIGEST_TIME_IST") || "17:00" });
      if (body.clear) { devDigestTime = ""; return json(res, { ok: true, cleared: true }); }
      if (!/^\d{2}:\d{2}$/.test(body.time || "")) return json(res, { error: "time must be HH:MM" }, 400);
      devDigestTime = body.time;
      return json(res, { ok: true, time: devDigestTime });
    }
    return json(res, { error: "Unknown report action" }, 404);
  }

  if (resource === "contact" && req.method === "POST") {
    if (!body.name || !body.email || !body.subject || !body.description)
      return json(res, { error: "name, email, subject and description are required." }, 400);
    console.log(`  [dev] contact form from ${body.email}: ${body.subject}`);
    return json(res, { ok: true, note: "dev server — no email sent" });
  }

  if (resource === "whatsapp" && parts[2] === "status")
    return json(res, { note: "dev server — WhatsApp not emulated" });

  if (resource === "payment") return json(res, { skipped: true, reason: "local dev" });

  return json(res, { error: "Not found (dev server)." }, 404);
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === "/" || p === "") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found: " + p);
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

// shared/pricing.mjs is an ES module, so it is pulled in with a dynamic import
// before the server starts listening — that way PRICING is always populated by
// the time the first request arrives.
// Same 32-character alphabet and length as the Worker's newTicketCode.
const DEV_TICKET_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function devTicketCode() {
  let out = "";
  for (let i = 0; i < 10; i++)
    out += DEV_TICKET_ALPHABET[Math.floor(Math.random() * DEV_TICKET_ALPHABET.length)];
  return out;
}

async function bootstrap() {
  const pricing = await import("./shared/pricing.mjs");
  PRICING = pricing.PRICING;
  pricingPromptLine = pricing.pricingPromptLine;
  const facts = await import("./shared/facts.mjs");
  factsPromptBlock = facts.factsPromptBlock;
  groundingRuleBlock = facts.groundingRuleBlock;
  const qr = await import("./shared/qr.mjs");
  qrPng = qr.qrPng;
  qrSvg = qr.qrSvg;

  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      try {
        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
          await handleApi(req, res, url);
        } else {
          serveStatic(req, res, url);
        }
      } catch (err) {
        console.error("[dev] error:", err);
        if (!res.headersSent) json(res, { error: "Server error", detail: err.message }, 500);
        else res.end();
      }
    })
    .listen(PORT, () => {
      console.log(`\n  Convention dev server → http://localhost:${PORT}\n`);
      console.log(`  chat : ${key("GROQ_API_KEY") ? "Groq streaming (real model)" : "canned replies, streamed (set GROQ_API_KEY for the real model)"}`);
      console.log(`  tts  : ${key("DEEPGRAM_API_KEY") ? "Deepgram (real voice)" : "none — browser voice fallback"}\n`);
    });
}

bootstrap().catch((err) => {
  console.error("[dev] failed to start:", err);
  process.exit(1);
});

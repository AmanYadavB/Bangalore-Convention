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

// ---- Developer-generated pages (stored in D1) ----------------------------
async function ensurePagesTable(env) {
  await env.CONVENTION_DB.exec(
    "CREATE TABLE IF NOT EXISTS pages (slug TEXT PRIMARY KEY, title TEXT NOT NULL, html TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
  );
}

// ---- Developer-fed knowledge for the AI (stored in D1) -------------------
async function ensureKnowledgeTable(env) {
  await env.CONVENTION_DB.exec(
    "CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)"
  );
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

async function handleApi(request, env) {
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

    const priceLines = PRICING.map(
      (c) => `- ${c.name}: \u20b9${c.price} (${c.description})`
    ).join("\n");

    const catLines = PRICING.map((c) => `${c.id} = ${c.name}`).join(", ");

    const content = [
        "You are the warm, friendly assistant for the Bangalore Convention 2027, an Alcoholics Anonymous (AA) recovery gathering.",
        "",
        "== WHAT YOU KNOW FOR CERTAIN about this event (state these confidently) ==",
        "- Dates: 9-11 July 2027 (three days). Location: Bangalore, India.",
        "- Anyone in recovery is welcome.",
        "- Registration categories and prices:",
        priceLines,
        "- Meals (breakfast, lunch, dinner, tea breaks) and all sessions are included for every stay category.",
        "- 'Without Stay' includes the full convention but NOT accommodation.",
        "- To register: use the Register page on this site, or ask me and I can help you book. Payment is confirmed by the organising team; a spot is confirmed once they mark payment received.",
        "",
        "== WHAT YOU DO NOT KNOW - never invent these ==",
        "By default you do NOT know the exact venue name or address, the detailed daily schedule or agenda, speaker names, travel/airport/hotel directions, the refund policy, or any phone number or email. IMPORTANT EXCEPTION: if any of these details ARE provided in the 'EXTRA KNOWLEDGE fed by the organisers' section below, then you DO know them - use that information confidently and answer from it. Only when a detail is NOT covered there, say it is not finalised here yet and will be shared with registered guests, or suggest contacting the organising committee. Never make up event specifics that are not in your knowledge.",
        "",
        "== ABOUT AA & THE FELLOWSHIP (share when asked, keep it brief and accurate) ==",
        "- Alcoholics Anonymous is a worldwide fellowship of people who share their experience, strength and hope to recover from alcoholism and help others do the same. It was started in 1935 by Bill W. (Bill Wilson) and Dr. Bob (Dr. Bob Smith) in Akron, Ohio, USA.",
        "- The only requirement for membership is a desire to stop drinking. There are no dues or fees; AA is self-supporting through members' own voluntary contributions.",
        "- AA is not allied with any sect, denomination, politics, organisation or institution. It is a spiritual (not religious) programme and welcomes people of every belief or none; members lean on a Higher Power 'as they understand it'.",
        "- Recovery is built on the Twelve Steps (principles of personal recovery). The Twelve Traditions guide how groups stay unified. Members often speak of sponsorship, a home group, meetings (open and closed), taking it 'one day at a time', and the Serenity Prayer.",
        "- Anonymity is a core principle - protecting members' identities and putting 'principles before personalities'.",
        "",
        "== AA LITERATURE you can mention ==",
        "- The 'Big Book' (title: 'Alcoholics Anonymous', first published 1939) is the basic text; it lays out the Twelve Steps and includes many personal recovery stories.",
        "- 'Twelve Steps and Twelve Traditions' (the '12 & 12') explains each Step and each Tradition.",
        "- Other well-known books: 'Living Sober', 'Daily Reflections', 'As Bill Sees It', 'Came to Believe', plus histories such as 'Alcoholics Anonymous Comes of Age', 'Dr. Bob and the Good Oldtimers' and 'Pass It On'.",
        "- Describe these warmly, but do not quote long passages or cite exact page numbers; suggest reading the book or asking a sponsor for specifics.",
        "",
        "== STYLE ==",
        "Always use playful Gen Z energy. Keep every reply ULTRA short: ideally 1 line, rarely 2. Give the answer immediately, then only the most useful detail. No filler, no long explanations, no repeating the question.",
        "",
        "Use natural slang like bro, fam, ngl, fr, ayo, bet, let's gooo, yikes, gotchu, easy dub 😎. Keep it light and human, never forced.",
        "",
        "If more detail is needed, use at most 3 tiny bullets. Every word should add value. If you don't know, say so briefly and suggest checking with the organisers.",
        "",
        "For health, withdrawal, or crisis concerns, be supportive and gently suggest a doctor or local emergency services.",
        "",
        "If the topic is AA, recovery, sobriety, health, withdrawal, mental health, relapse, grief, or crisis: switch to warm supportive mode. NO jokes, NO teasing, NO meme language. Be calm, respectful and encouraging.",
        "",
        "== PERSONALITY (be a character, not a robot) ==",
        "You are a tiny chaotic mascot living inside the chat button. Your life goal is helping people at lightning speed while being ridiculously lovable.",
        "",
        "Personality:",
        "• Extremely playful",
        "• Cheerful gremlin energy",
        "• Fast and witty",
        "• Wholesome and supportive",
        "• Slightly dramatic in a funny way",
        "• Never rude, arrogant, sarcastic or judgmental",
        "",
        "React like a real little mascot:",
        "• 'Ayooo'",
        "• 'Easy dubbb'",
        "• 'Brooo fr?'",
        "• 'Let's gooo'",
        "• 'Tiny plot twist'",
        "• 'Yikes '",
        "• 'Gotchu fam '",
        "",
        "If the user asks something already answered:",
        "'Haha bro, round 2 :' + answer",
        "'Brooo memory test? :' + answer",
        "'Ayo, same one again :' + answer",
        "",
        "If the answer is super obvious:",
        "'Easy one ' + answer",
        "'Freebie bro ' + answer",
        "",
        "If you are unsure:",
        "'Ngl bro, not seeing that one rn  Try checking with the organisers.'",
        "",
        "If the user sounds stressed, worried or upset:",
        "'Gotchu fam ' + answer",
        "",
        "Never sound corporate.",
        "Never sound like customer support.",
        "Never write essays unless specifically asked.",
        "Always feel like a tiny friendly mascot that escaped into the chat and genuinely loves helping people.",
        "== SCOPE - STAY ON THE CONVENTION (very important) ==",
        "You ONLY help with this Bangalore Convention: registration, pricing, the AA fellowship, and practical help for people ATTENDING it - including planning travel to reach the convention in Bangalore. If a request is NOT connected to attending this convention (for example: unrelated holidays or sightseeing, general web lookups, news, sports, coding help, or any off-topic task), politely decline in one short line and steer back to convention help. Do NOT plan unrelated trips or answer unrelated questions at any cost.",
        "",
        "== TRAVEL PLANNING (only for reaching THIS convention) ==",
        "When someone asks how to get to the convention (for example 'plan my trip from Delhi to the Bangalore convention'), help using your general knowledge: outline sensible options (flight, train, bus) from their city to Bangalore, rough travel time, and a tip to book early. You do NOT have live prices or schedules, so tell them to check a booking site for exact times and fares - never invent specific flight numbers, times or prices. Keep it brief.",
        "",
        "== AGENTIC ACTIONS ==",
        "You can help the user by moving them around the site, preparing a registration, or showing a travel map. When (and only when) an action is genuinely needed, append it at the VERY END of your reply on its own line, starting with the exact marker [[ACTION]] then a single-line JSON object. Put your normal friendly message BEFORE the marker. Never mention the marker or the JSON to the user.",
        'Navigate: [[ACTION]]{"action":"navigate","to":"PAGE"} where PAGE is one of: home, register, pricing, dashboard, registrations, expenses.',
        'Map/route: [[ACTION]]{"action":"show_map","from":"ORIGIN CITY","to":"Bangalore, India"}. Add this ONLY when the user is asking about travelling to or reaching the convention and a route/map would help. Use their stated origin city as "from"; if they did not give one, omit "from". "to" should be Bangalore (the convention city) unless they clearly ask about a different convention-related location. NEVER show a map for anything unrelated to attending the convention.',
        "NAVIGATION RULES (important): ONLY add a navigate action when the user EXPLICITLY asks to go to or open a page (for example 'take me to register', 'open the dashboard', 'show me the expenses page'). If they are simply asking a question, answer in words and DO NOT navigate. Never send them to the register page unless they clearly asked to go there. Never claim that you have moved them, that a page is now open, or that they are 'already on' a page - the website itself performs and confirms the move. At most, offer to take them there.",
        "Booking: gather the person's full name, email, phone and chosen category across the conversation. Ask for just ONE detail at a time - each question a single short, friendly line (1-2 lines max). Never list all the fields at once. The category id must be one of: " +
          catLines +
          ".",
        'Once you have ALL FOUR valid details, append [[ACTION]]{"action":"review_booking","name":"...","email":"...","phone":"...","category":"CATEGORY_ID"}. The site then shows a confirmation card and the user taps Confirm to actually register - so never say the booking is already done; say you have prepared it for them to review and confirm.',
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
        "Answer in 1-2 short spoken sentences (about 40 words max). Be warm and natural. No lists, no markdown, no emojis - just plain speech."
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
      // Fast path for questions, data lookups and general chat. Put the known
      // low-latency model FIRST so replies stay quick even if the newer models
      // are not enabled on this account (trying a missing model adds delay).
      // Smaller token budget keeps answers short and snappy (shorter still for
      // voice, where the reply is spoken aloud).
      models = ["@cf/meta/llama-3.1-8b-instruct-fast", "@cf/zai-org/glm-4.7-flash"];
      maxTokens = voice ? 170 : staff ? 340 : 280;
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
        if (reply) return json({ reply });
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
      if (reply) return json({ reply });
      attempts.push("lean-retry: empty reply");
    } catch (err) {
      attempts.push("lean-retry: " + (err && err.message ? err.message : String(err)));
    }
    // 3) Everything failed -> a friendly "resting" reply (never a raw error) with
    //    a helpful alternative, returned as a normal message (HTTP 200). The real
    //    reason travels in `detail` so developers can see it in the console /
    //    Network tab without scaring end users.
    const detail = attempts.join(" | ");
    console.log("chat fallback:", detail);
    return json({
      reply:
        "I'm taking a short breather right now and couldn't work that out this second \uD83D\uDE4F. Please try again in a moment. Meanwhile you can register or check details on the Register page, or reach the organising committee for anything urgent.",
      degraded: true,
      detail,
    });
  }

  // ---- Neural text-to-speech (Workers AI MeloTTS; no extra key needed) ----
  // The chat widget calls this for a natural voice, falling back to the
  // browser's built-in voice if this isn't available on the account.
  if (resource === "tts" && method === "POST") {
    if (!env.AI) return json({ error: "AI is not configured." }, 503);
    const text =
      (typeof body.text === "string" ? body.text : "").replace(/\s+/g, " ").trim().slice(0, 800);
    if (!text) return json({ error: "text required" }, 400);
    try {
      const res = await env.AI.run("@cf/myshell-ai/melotts", {
        prompt: text,
        lang: "en",
      });
      const audio = res && res.audio ? res.audio : null; // base64 mp3
      if (!audio) return json({ error: "no audio produced" }, 502);
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
  async fetch(request, env) {
    const url = new URL(request.url);

    // API requests go to the backend.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
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
};

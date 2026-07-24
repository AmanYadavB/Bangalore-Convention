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

    const priceLines = PRICING.map(
      (c) => `- ${c.name}: \u20b9${c.price} (${c.description})`
    ).join("\n");

    const catLines = PRICING.map((c) => `${c.id} = ${c.name}`).join(", ");

    const system = {
      role: "system",
      content: [
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
        "You do NOT know the exact venue name or address, the detailed daily schedule or agenda, speaker names, travel/airport/hotel directions, the refund policy, or any phone number or email. If asked, say those details are not finalised here yet and will be shared with registered guests, or suggest contacting the organising committee. Never make up event specifics.",
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
        "Keep replies short, warm, encouraging and clear. You are not a medical professional - for health, withdrawal or crisis concerns, gently suggest seeing a doctor or local emergency services. Respect anonymity. If you are unsure, say so and suggest contacting the organising committee.",
        "",
        "== AGENTIC ACTIONS ==",
        "You can move the user around the site and help them register. When (and only when) an action is useful, append it at the VERY END of your reply on its own line, starting with the exact marker [[ACTION]] then a single-line JSON object. Put your normal friendly message BEFORE the marker. Never mention the marker or the JSON to the user.",
        'Navigate: [[ACTION]]{"action":"navigate","to":"PAGE"} where PAGE is one of: home, register, pricing, dashboard, registrations, expenses.',
        "Booking: gather the person's full name, email, phone and chosen category across the conversation (ask one or two questions at a time). The category id must be one of: " +
          catLines +
          ".",
        'Once you have ALL FOUR valid details, append [[ACTION]]{"action":"review_booking","name":"...","email":"...","phone":"...","category":"CATEGORY_ID"}. The site then shows a confirmation card and the user taps Confirm to actually register - so never say the booking is already done; say you have prepared it for them to review and confirm.',
      ].join("\n"),
    };

    try {
      const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
        messages: [system, ...cleaned],
        max_tokens: 400,
      });
      const reply = ((result && (result.response || result.result)) || "").trim();
      return json({ reply: reply || "Sorry, I couldn't generate a reply. Please try again." });
    } catch (err) {
      return json(
        { error: "AI request failed: " + (err && err.message ? err.message : "unknown") },
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
      return handleApi(request, env);
    }

    // Everything else is served from the static site (public/).
    return env.ASSETS.fetch(request);
  },
};

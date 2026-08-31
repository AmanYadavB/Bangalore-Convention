// The single source of truth for what the chatbot KNOWS and DOESN'T KNOW.
//
// Like shared/pricing.mjs, this exists because facts used to live as prose
// inside the system prompt: editing the prompt was the only way to change a
// fact, and nothing else (the fact-checker, the Data Center page) could read
// them. The prompt sections below are GENERATED from this module, and later
// phases reuse the same data to verify replies and to display "everything the
// AI knows" in one place.
//
// Imported by worker.js (bundled by wrangler) and by dev-server.js via a
// dynamic import. Keep this file pure ESM with no environment access.

import { PRICING } from "./pricing.mjs";

export const FACTS = {
  event: {
    name: "Bangalore Convention 2027",
    dateDisplay: "9th to 11th July 2027",
    year: 2027,
    month: 7,
    startDay: 9,
    endDay: 11,
    city: "Bangalore, India",
  },
  audience: "Anyone in recovery is welcome. Even non members are welcome.",
  meals: ["breakfast", "lunch", "dinner", "tea breaks"],
  withoutStay: "The 'No Stay' categories (Full Event, Friday Only, Saturday Only, Sunday Only) = convention access without accommodation.",
  registerVia:
    "To register: Register page on this site, or I can book it right here in this chat.",
  aa: { founded: 1935, bigBookYear: 1939 },
  venue: {
    name: "RG Royal Hotel",
    address: "19/1, Old 77, Near ISKCON Temple, Mahalakshmi Layout, Bangalore 560086",
    mapsUrl: "https://share.google/JdGXdtflGIEztpihz",
  },
};

// Things people ask about that are NOT confirmed yet. The bot must say so and
// pivot instead of inventing. (A later phase turns these into staff-managed
// rows with a confirmed/TBD status; until then the list is static.)
export const UNKNOWNS = [
  "session schedule / programme",
  "speaker names",
  "refund or cancellation policy",
  "organiser phone numbers or emails",
  "hotels near the venue (for guests not staying at RG Royal Hotel)",
  "wifi, parking or other venue facilities",
  "detailed transit directions to the venue (e.g. from the airport)",
];

// Rendered into the system prompt. `managedFacts` is reserved for the phase
// where staff confirm facts from the Data Center page; rows with
// status "confirmed" will join WHAT YOU KNOW and unconfirmed ones the
// DON'T-KNOW list. Until then callers pass nothing.
export function factsPromptBlock(managedFacts = []) {
  const priceLines = PRICING.map(
    (c) => `- ${c.name}: ₹${c.price} (${c.description})`
  ).join("\n");
  const confirmed = managedFacts.filter(
    (f) => f.status === "confirmed" && String(f.value || "").trim()
  );
  const unknownLabels = [
    ...managedFacts
      .filter((f) => f.status !== "confirmed" || !String(f.value || "").trim())
      .map((f) => f.label),
    ...(managedFacts.length ? [] : UNKNOWNS),
  ];
  const lines = [
    "== WHAT YOU KNOW (reference material — deliver it in YOUR voice, never formally) ==",
    `- Dates: ${FACTS.event.dateDisplay}. Location: ${FACTS.event.city}.`,
    `- Venue: ${FACTS.venue.name}, ${FACTS.venue.address}.`,
    `- ${FACTS.audience}`,
    "- Registration categories and prices:",
    priceLines,
    `- Meals (${FACTS.meals.join(", ")}) and sessions included for the day(s) each category covers.`,
    `- ${FACTS.withoutStay}`,
    `- ${FACTS.registerVia}`,
  ];
  for (const f of confirmed) lines.push(`- ${f.label}: ${f.value}`);
  lines.push(
    "",
    "== WHAT YOU DON'T KNOW (say this briefly and pivot — never dwell on it) ==",
    "You don't know: " +
      unknownLabels.join("; ") +
      " — UNLESS they appear in the 'EXTRA KNOWLEDGE' section below. If not there, say 'not confirmed yet, will be shared with registered guests' and immediately offer something you CAN do. Never invent specifics."
  );
  return lines.join("\n");
}

export function groundingRuleBlock() {
  return [
    "== GROUNDING — HARD RULE, OUTRANKS EVERYTHING EXCEPT SAFETY ==",
    "Never state a price, amount, date, address, phone number, URL, email or person's name that is not written in this prompt or given to you by the user in this conversation. If a detail is not here, it does not exist for you: say it's not confirmed yet and pivot to something you CAN help with. A true 'not confirmed yet' always beats a made-up answer, no matter how helpful the made-up answer would sound.",
    "The Q→A example lines in this prompt are tone references only — NEVER copy them into a reply verbatim, never wrap your reply in quote marks, and never output bracketed placeholders like [city]: use the real detail from the conversation or drop that sentence.",
    "Quote prices, amounts and dates digit-for-digit exactly as written in this prompt — never round, shorten, approximate or drop digits (₹2000 must never become ₹200). If you can't fit every price exactly, name one or two exactly instead of shortening them all.",
  ].join("\n");
}

// Appended AFTER the user's last message on every model call. Small models
// ignore the LENGTH rule buried mid-prompt; a reminder at the very end of the
// conversation (recency) is what actually holds reply length down.
export const STYLE_REMINDER =
  "Reminder: reply in 1-3 short sentences MAX unless the user explicitly asked for a list, full details or a step-by-step. Punchy > long.";

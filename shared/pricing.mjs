// The single source of truth for ticket categories and prices.
//
// Imported by worker.js (bundled by wrangler) and by dev-server.js via a
// dynamic import. Previously this list lived in four places — worker.js,
// dev-server.js, and hardcoded as prose inside both chat system prompts —
// so a price change silently left the chatbot quoting the old numbers.
// The prompt lines below are GENERATED from this array for that reason.

export const PRICING = [
  {
    id: "full-event",
    name: "No Stay - Full Event",
    description: "All three days of the convention. Accommodation not included.",
    price: 6000,
  },
  {
    id: "friday-only",
    name: "No Stay - Friday Only",
    description: "Friday only. Accommodation not included.",
    price: 2000,
  },
  {
    id: "saturday-only",
    name: "No Stay - Saturday Only",
    description: "Saturday only. Accommodation not included.",
    price: 3000,
  },
  {
    id: "sunday-only",
    name: "No Stay - Sunday Only",
    description: "Sunday only. Accommodation not included.",
    price: 2000,
  },
  {
    id: "triple-sharing",
    name: "With Stay - Triple Sharing",
    description: "Room shared by three. All meals & sessions included.",
    price: 10000,
  },
  {
    id: "twin-sharing",
    name: "With Stay - Twin Sharing",
    description: "Room shared by two. All meals & sessions included.",
    price: 13000,
  },
  {
    id: "single-sharing",
    name: "With Stay - Single Sharing",
    description: "Private room for one. All meals & sessions included.",
    price: 16000,
  },
];

export const findCategory = (id) => PRICING.find((c) => c.id === id);

// Short labels the chatbot uses when quoting prices, cheapest first.
const SHORT_LABEL = {
  "friday-only": "Friday only",
  "sunday-only": "Sunday only",
  "saturday-only": "Saturday only",
  "full-event": "full event, no stay",
  "triple-sharing": "triple sharing",
  "twin-sharing": "twin sharing",
  "single-sharing": "single room",
};

const byPrice = () => [...PRICING].sort((a, b) => a.price - b.price);

// "₹2000 Friday only, ₹2000 Sunday only, ₹3000 Saturday only, ₹6000 full event, no stay, ₹10000 triple sharing, ₹13000 twin sharing, ₹16000 single room"
export function pricingPhrase() {
  return byPrice()
    .map((c) => `₹${c.price} ${SHORT_LABEL[c.id] || c.name}`)
    .join(", ");
}

// The full line injected into the chat system prompt.
export function pricingPromptLine() {
  return `Prices: ${pricingPhrase()}. Meals included for the days you attend.`;
}

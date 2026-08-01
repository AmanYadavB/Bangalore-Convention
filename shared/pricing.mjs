// The single source of truth for ticket categories and prices.
//
// Imported by worker.js (bundled by wrangler) and by dev-server.js via a
// dynamic import. Previously this list lived in four places — worker.js,
// dev-server.js, and hardcoded as prose inside both chat system prompts —
// so a price change silently left the chatbot quoting the old numbers.
// The prompt lines below are GENERATED from this array for that reason.

export const PRICING = [
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

export const findCategory = (id) => PRICING.find((c) => c.id === id);

// Short labels the chatbot uses when quoting prices, cheapest first.
const SHORT_LABEL = {
  "without-stay": "no stay",
  "triple-sharing": "triple sharing",
  "double-sharing": "double",
  "single-sharing": "solo room",
};

const byPrice = () => [...PRICING].sort((a, b) => a.price - b.price);

// "₹1500 (no stay), ₹3200 triple sharing, ₹4200 double, ₹6000 solo room"
export function pricingPhrase() {
  return byPrice()
    .map((c) => `₹${c.price} ${SHORT_LABEL[c.id] || c.name}`)
    .join(", ");
}

// The full line injected into the chat system prompt.
export function pricingPromptLine() {
  return `Prices: ${pricingPhrase()}. Meals included in all of them.`;
}

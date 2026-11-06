// Deterministic natural-language constraint parser for shopping requests.
// No LLM dependency: the demo query must parse identically every time.

import type { SearchConstraints } from "./types.ts";

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, fifteen: 15,
  twenty: 20, thirty: 30, couple: 2, few: 3, dozen: 12,
};

const NUM = String.raw`(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty|couple|few|dozen)`;

export function toNumber(token: string): number | null {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return NUMBER_WORDS[t] ?? null;
}

/** Canonical categories, most specific patterns first. */
const CATEGORY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(night ?stands?|bedside tables?)\b/, "Nightstands"],
  [/\b(dining|kitchen) tables?\b/, "Dining Tables"],
  [/\bcoffee tables?\b/, "Coffee Tables"],
  [/\b(side|end|accent) tables?\b/, "Side Tables"],
  [/\bconsole tables?\b/, "Console Tables"],
  [/\b(media consoles?|tv stands?|media (units?|cabinets?))\b/, "Media Consoles"],
  [/\b(sideboards?|buffets?|credenzas?)\b/, "Sideboards"],
  [/\bdining chairs?\b/, "Dining Chairs"],
  [/\b(arm ?chairs?|accent chairs?|lounge chairs?)\b/, "Lounge Chairs"],
  [/\b(office|desk) chairs?\b/, "Office Chairs"],
  [/\b(sofas?|couch(es)?|sectionals?|loveseats?|settees?)\b/, "Sofas"],
  [/\bbenche?s?\b/, "Benches"],
  [/\b(book ?(shelf|shelves|cases?)|shelving units?)\b/, "Bookshelves"],
  [/\b(dressers?|chests? of drawers)\b/, "Dressers"],
  [/\b(bed frames?|beds)\b|\bbed\b/, "Beds"],
  [/\bdesks?\b/, "Desks"],
  [/\bstools?\b/, "Stools"],
  // Generic families last.
  [/\bchairs?\b/, "Chairs"],
  [/\btables?\b/, "Tables"],
];

/** Generic families match any product category ending in the family word. */
export const CATEGORY_FAMILIES: Record<string, string> = {
  Chairs: "chairs",
  Tables: "tables",
};

export const MATERIALS: Record<string, string> = {
  walnut: "walnut", oak: "oak", maple: "maple", cherry: "cherry", ash: "ash",
  teak: "teak", pine: "pine", birch: "birch", mahogany: "mahogany", acacia: "acacia",
  beech: "beech", elm: "elm", mango: "mango", bamboo: "bamboo", rattan: "rattan",
  wicker: "wicker", cane: "cane", leather: "leather", linen: "linen", velvet: "velvet",
  wool: "wool", boucle: "boucle", "bouclé": "boucle", cotton: "cotton", marble: "marble",
  travertine: "travertine", glass: "glass", steel: "steel", metal: "metal",
  aluminum: "aluminum", aluminium: "aluminum", iron: "iron", brass: "brass", concrete: "concrete",
};

const MATERIAL_RE = new RegExp(String.raw`\b(${Object.keys(MATERIALS).join("|")})\b`, "i");

export function parseCategory(q: string): string | null {
  const s = q.toLowerCase();
  for (const [re, cat] of CATEGORY_PATTERNS) if (re.test(s)) return cat;
  return null;
}

export function parseMaterial(q: string): string | null {
  const m = q.match(MATERIAL_RE);
  return m ? MATERIALS[m[1].toLowerCase()] : null;
}

/** All materials mentioned in the text, in order of appearance (deduplicated). */
export function parseAllMaterials(q: string): string[] {
  const re = new RegExp(MATERIAL_RE.source, "gi");
  const out: string[] = [];
  for (const m of q.matchAll(re)) {
    const v = MATERIALS[m[1].toLowerCase()];
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

const UNIT_AFTER = /^\s*(-|\s)?(days?|weeks?|months?|business|seats?|seaters?|people|persons?|guests?|diners?|inch|inches|in\b|cm|ft|feet|lbs?|pounds|kg)/i;

function moneyToCents(raw: string, kSuffix: string | undefined): number | null {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  const dollars = kSuffix ? n * 1000 : n;
  return Math.round(dollars * 100);
}

/**
 * Maximum price in cents. Recognises "under $1,500", "below 1500 dollars",
 * "budget of $1.5k", "$1500 or less", "less than 2000", "between $800 and $1,500".
 */
export function parseMaxPrice(q: string): number | null {
  const s = q.toLowerCase();
  const money = String.raw`\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k)?\b`;

  const between = s.match(new RegExp(String.raw`between\s+\$?\s*\d[\d,]*(?:\.\d{1,2})?\s*k?\s+and\s+${money}`));
  if (between) return moneyToCents(between[1], between[2]);

  const bounded = new RegExp(
    String.raw`(under|below|less than|no more than|not more than|at most|up to|max(?:imum)?(?: of)?|budget(?: is| of)?|cheaper than|within|for)\s+${money}(\s*(?:dollars|usd|bucks))?`,
    "g",
  );
  for (const m of s.matchAll(bounded)) {
    const after = s.slice((m.index ?? 0) + m[0].length);
    const hasDollar = m[0].includes("$") || Boolean(m[4]) || Boolean(m[3]);
    if (!hasDollar && UNIT_AFTER.test(after)) continue; // "within 14 days", "for 6 people"
    if (!hasDollar && (m[1] === "within" || m[1] === "for")) continue; // ambiguous without $
    return moneyToCents(m[2], m[3]);
  }

  const trailing = s.match(new RegExp(String.raw`${money}(?:\s*(?:dollars|usd|bucks))?\s*(?:or less|or under|max(?:imum)?|tops|budget)`));
  if (trailing) return moneyToCents(trailing[1], trailing[2]);

  // A bare "$1,500" with no qualifier is treated as the shopper's budget.
  const bare = s.match(/\$\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k)?\b/);
  if (bare) return moneyToCents(bare[1], bare[2]);
  return null;
}

/** Minimum seating capacity: "seats six", "seating for 6", "six-person", "6-seater", "for six people". */
export function parseMinSeats(q: string): number | null {
  const s = q.toLowerCase();
  const patterns = [
    new RegExp(String.raw`\bseats?\s+(?:at least\s+|up to\s+|a minimum of\s+)?${NUM}\b`),
    new RegExp(String.raw`\bseating\s+(?:for\s+)?(?:at least\s+|up to\s+)?${NUM}\b`),
    new RegExp(String.raw`\b(?:fits?|accommodates?|holds?)\s+(?:at least\s+|up to\s+)?${NUM}\b`),
    new RegExp(String.raw`\b${NUM}[-\s]?(?:seaters?|seats?|persons?|people|guests?|diners?)\b`),
    new RegExp(String.raw`\bfor\s+(?:at least\s+)?${NUM}\b(?!\s*(?:-|\s)?(?:days?|weeks?|months?|dollars|usd|k\b))`),
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = toNumber(m[1]);
      if (n !== null && n >= 1 && n <= 100) return n;
    }
  }
  return null;
}

export interface DeliveryWindow {
  days: number;
  phrase: string;
}

/** Maximum delivery window: "within 14 days", "in two weeks", "by next week", "10-day delivery". */
export function parseDeliveryWindow(q: string): DeliveryWindow | null {
  const s = q.toLowerCase();
  const unitDays = (unit: string) => (unit.startsWith("week") ? 7 : unit.startsWith("month") ? 30 : 1);

  const windowed = s.match(new RegExp(
    String.raw`\b(within|in|under|less than|no more than|inside(?: of)?|by|before)\s+(?:the\s+next\s+)?${NUM}\s*(?:business\s+)?(days?|weeks?|months?)\b`,
  ));
  if (windowed) {
    const n = toNumber(windowed[2]);
    if (n !== null) return { days: n * unitDays(windowed[3]), phrase: windowed[0] };
  }
  const bareUnit = s.match(/\b(within|in|under|by)\s+(a|the next)\s+(day|week|month)\b/);
  if (bareUnit) return { days: unitDays(bareUnit[3]), phrase: bareUnit[0] };

  const next = s.match(/\b(by|before)\s+next\s+week\b/);
  if (next) return { days: 7, phrase: next[0] };

  const dayDelivery = s.match(new RegExp(String.raw`\b${NUM}[-\s](day|week)\s+(?:delivery|shipping)\b`));
  if (dayDelivery) {
    const n = toNumber(dayDelivery[1]);
    if (n !== null) return { days: n * unitDays(dayDelivery[2]), phrase: dayDelivery[0] };
  }
  return null;
}

export function parseConstraints(query: string): SearchConstraints {
  return {
    category: parseCategory(query),
    material: parseMaterial(query),
    max_price_cents: parseMaxPrice(query),
    minimum_seats: parseMinSeats(query),
    max_delivery_days: parseDeliveryWindow(query)?.days ?? null,
  };
}

export function hasAnyConstraint(c: SearchConstraints): boolean {
  return Object.values(c).some((v) => v !== null);
}

const STOPWORDS = new Set([
  "find", "me", "a", "an", "the", "that", "which", "with", "for", "and", "or", "of", "in",
  "to", "i", "want", "need", "looking", "show", "some", "any", "please", "can", "you", "get",
  "buy", "is", "are", "it", "my", "our", "something", "under", "within", "good", "nice",
]);

/** Keyword tokens used only as a fallback when no structured constraint was found. */
export function keywordTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

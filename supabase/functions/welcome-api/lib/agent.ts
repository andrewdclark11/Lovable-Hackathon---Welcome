// Deterministic merchant-side agent. Answers ONLY from the selected product's
// stored attributes and explicitly acknowledges anything it cannot verify.
// It receives a single merchant + product, so it has no way to reveal data
// belonging to any other merchant or product.

import { formatCents } from "./matcher.ts";
import { parseAllMaterials, parseDeliveryWindow, parseMaxPrice, parseMinSeats, toNumber } from "./parser.ts";
import type { Merchant, Product } from "./types.ts";

export interface AgentAnswer {
  answer: string;
  verified_facts: string[];
  missing_information: string[];
  topics: string[];
  simulated: true;
}

const COLORS = [
  "black", "white", "grey", "gray", "brown", "natural", "red", "blue", "green", "navy",
  "beige", "cream", "ivory", "ebony", "espresso", "honey", "charcoal", "pink", "yellow",
  "orange", "purple", "tan", "dark", "blonde",
];
const COLOR_RE = new RegExp(String.raw`\b(${COLORS.join("|")})\b`, "i");

interface UnknownTopic {
  key: string;
  re: RegExp;
  label: string;
}

/** Topics the catalog schema does not store; the agent must never guess these. */
const UNKNOWN_TOPICS: UnknownTopic[] = [
  { key: "dimensions", re: /\b(dimensions?|size|how (big|wide|long|tall)|length|width|height|depth|measure(ments)?|inches|cm)\b/i, label: "dimensions" },
  { key: "warranty", re: /\b(warrant(y|ies)|guarantee)\b/i, label: "warranty terms" },
  { key: "returns", re: /\b(returns?|refunds?|exchange)\b/i, label: "return policy" },
  { key: "shipping_cost", re: /\b(shipping (cost|fee|price)|delivery (cost|fee|charge)|free (shipping|delivery)|white[- ]glove)\b/i, label: "shipping cost" },
  { key: "assembly", re: /\b(assembl(y|e|ed)|set ?up|install(ation)?)\b/i, label: "assembly requirements" },
  { key: "care", re: /\b(care|clean(ing)?|maintenance|maintain|scratch(es)?|stain resistant)\b/i, label: "care instructions" },
  { key: "weight", re: /\b(weight|weigh|heavy|lbs?|kg)\b/i, label: "weight" },
  { key: "pickup", re: /\b(pick ?up|showroom|in person|location|store hours)\b/i, label: "pickup or showroom details" },
  { key: "discount", re: /\b(discount|coupon|sale|promo(tion)?|negotiat\w*|lower price|best price)\b/i, label: "discounts or price negotiation" },
  { key: "origin", re: /\b(where (is it|it is|are they) made|made in|country of origin|sustainab\w*|fsc|certified)\b/i, label: "origin or certifications" },
];

function nounFor(product: Product): string {
  const c = product.category.toLowerCase();
  if (c.endsWith("tables")) return "table";
  if (c.endsWith("chairs")) return "chair";
  if (c.endsWith("sofas")) return "sofa";
  if (c.endsWith("benches")) return "bench";
  if (c.endsWith("bookshelves")) return "bookshelf";
  if (c.endsWith("consoles")) return "console";
  return "item";
}

function inventoryLabel(s: Product["inventory_status"]): string {
  return s.replace(/_/g, " ");
}

function weeksPhrase(days: number): string {
  if (days % 7 === 0) {
    const w = days / 7;
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
    const n = words[w] ?? String(w);
    return w === 1 ? "one week" : `${n} weeks`;
  }
  return `${days} days`;
}

export function answerQuestion(merchant: Merchant, product: Product, question: string): AgentAnswer {
  const q = question.toLowerCase();
  const noun = nounFor(product);
  const sentences: string[] = [];
  const facts: string[] = [];
  const missing: string[] = [];
  const topics: string[] = [];
  const addFact = (f: string) => { if (!facts.includes(f)) facts.push(f); };
  const addMissing = (m: string) => { if (!missing.includes(m)) missing.push(m); };

  // --- Color / finish (not stored in the catalog) ---------------------------
  const colorMatch = q.match(COLOR_RE);
  const asksColor = Boolean(colorMatch) || /\b(colou?rs?|finish(es)?|stain(ed)?)\b/.test(q);
  if (asksColor) {
    topics.push("color");
    if (colorMatch) {
      sentences.push(`I don't have verified information about whether this ${noun} is available in ${colorMatch[1].toLowerCase()}.`);
      addMissing(`Availability in ${colorMatch[1].toLowerCase()}`);
    } else {
      sentences.push(`I don't have verified information about color or finish options for this ${noun}.`);
      addMissing("Color and finish options");
    }
  }

  // --- Seating ---------------------------------------------------------------
  if (/\b(seats?|seating|people|persons?|guests?|diners?|accommodates?|fits?|how many)\b/.test(q) && !/\bhow many days\b/.test(q)) {
    topics.push("seats");
    const wanted = parseMinSeats(q) ?? (() => {
      const m = q.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/);
      return m ? toNumber(m[1]) : null;
    })();
    if (product.seats === null) {
      sentences.push(`I don't have verified seating capacity for the ${product.name}.`);
      addMissing("Seating capacity");
    } else {
      addFact(`Seats ${product.seats}`);
      if (wanted === null) {
        sentences.push(`The ${product.name} seats ${product.seats} ${product.seats === 1 ? "person" : "people"}.`);
      } else if (product.seats === wanted) {
        sentences.push(`Yes. The ${product.name} seats ${product.seats} people.`);
      } else if (product.seats > wanted) {
        sentences.push(`Yes. The ${product.name} seats ${product.seats} people, which accommodates ${wanted}.`);
      } else {
        sentences.push(`No. The ${product.name} is listed as seating ${product.seats}, fewer than ${wanted}.`);
      }
    }
  }

  // --- Delivery --------------------------------------------------------------
  if (/\b(deliver(y|ed|s)?|arriv(e|es|al)|ship(s|ping|ped)?|lead time|how (long|soon)|when|days?|weeks?)\b/.test(q) &&
      !UNKNOWN_TOPICS[3].re.test(q)) {
    topics.push("delivery");
    const window = parseDeliveryWindow(q);
    if (product.delivery_days === null) {
      sentences.push(`I don't have a verified delivery estimate for the ${product.name}.`);
      addMissing("Delivery estimate");
    } else {
      addFact(`Listed delivery estimate: ${product.delivery_days} days`);
      if (window === null) {
        sentences.push(`The listed delivery estimate is ${product.delivery_days} days.`);
      } else {
        const within = product.delivery_days <= window.days;
        const span = /week/.test(window.phrase) ? weeksPhrase(window.days) : `${window.days} days`;
        sentences.push(
          `The listed delivery estimate is ${product.delivery_days} days, which is ${within ? "within" : "longer than"} ${span}.`,
        );
      }
    }
  }

  // --- Price -----------------------------------------------------------------
  if (/(\bprices?\b|\bcosts?\b|\bcharges?\b|\bpay\b|\bhow much\b|\$|\bexpensive\b|\bcheap\b|\bbudget\b|\bafford)/.test(q) && !UNKNOWN_TOPICS[3].re.test(q)) {
    topics.push("price");
    addFact(`Price: ${formatCents(product.price_cents)}`);
    const budget = parseMaxPrice(q);
    if (budget === null) {
      sentences.push(`The listed price is ${formatCents(product.price_cents)}.`);
    } else {
      sentences.push(
        `The listed price is ${formatCents(product.price_cents)}, which is ${
          product.price_cents <= budget ? "within" : "above"
        } a ${formatCents(budget)} budget.`,
      );
    }
  }

  // --- Material --------------------------------------------------------------
  const mentioned = parseAllMaterials(q);
  const asksSolid = /\b(solid|veneer|real wood|engineered|mdf|particle ?board)\b/.test(q);
  if (mentioned.length > 0 || asksSolid || /\b(material|made (of|from)|wood|what is it made)\b/.test(q)) {
    topics.push("material");
    if (product.material === null) {
      sentences.push(`I don't have verified material information for the ${product.name}.`);
      addMissing("Material");
    } else {
      const mat = product.material.toLowerCase();
      addFact(`Material: ${product.material}`);
      const other = mentioned.find((m) => m !== mat);
      if (mentioned.includes(mat)) {
        sentences.push(`Yes. The listed material is ${product.material}.`);
      } else if (other) {
        sentences.push(`No. The listed material is ${product.material}, not ${other}.`);
      } else {
        sentences.push(`The listed material is ${product.material}.`);
      }
      if (asksSolid) {
        if (/\bsolid\b/i.test(product.description ?? "")) {
          sentences.push(`The merchant's description calls it solid ${product.material}.`);
          addFact(`Described by the merchant as solid ${product.material}`);
        } else if (/\bveneer\b/i.test(product.description ?? "")) {
          sentences.push(`The merchant's description mentions veneer.`);
          addFact("Description mentions veneer");
        } else {
          sentences.push(`I can't verify whether it is solid ${product.material} or veneer.`);
          addMissing("Solid wood vs. veneer construction");
        }
      }
    }
  }

  // --- Stock -----------------------------------------------------------------
  if (/\b(in stock|stock|availab(le|ility)|sold out|inventory)\b/.test(q) && !asksColor) {
    topics.push("inventory");
    addFact(`Inventory status: ${inventoryLabel(product.inventory_status)}`);
    sentences.push(
      product.inventory_status === "in_stock"
        ? `Yes. The ${product.name} is listed as in stock.`
        : product.inventory_status === "out_of_stock"
        ? `The ${product.name} is listed as out of stock.`
        : `The ${product.name} is listed as ${inventoryLabel(product.inventory_status)}.`,
    );
  }

  // --- Checkout --------------------------------------------------------------
  if (/\b(buy|purchase|check ?out|order)\b/.test(q)) {
    topics.push("checkout");
    if (product.checkout_url) {
      addFact("Merchant checkout link configured");
      sentences.push(`${merchant.name} has a checkout link configured for this ${noun}; Welcome can create a checkout handoff to it.`);
    } else {
      sentences.push(`${merchant.name} has not configured a checkout link for this ${noun}; Welcome can create a simulated checkout handoff.`);
      addMissing("Merchant checkout link");
    }
  }

  // --- Topics the catalog does not store -------------------------------------
  for (const t of UNKNOWN_TOPICS) {
    if (t.re.test(q)) {
      topics.push(t.key);
      sentences.push(`I don't have verified information about ${t.label} for the ${product.name}.`);
      addMissing(t.label.charAt(0).toUpperCase() + t.label.slice(1));
    }
  }

  // --- Fallback: summarise verified facts ------------------------------------
  if (sentences.length === 0) {
    topics.push("summary");
    const parts = [
      `The ${product.name} from ${merchant.name} is listed at ${formatCents(product.price_cents)}`,
      product.material ? `made of ${product.material}` : null,
      product.seats !== null ? `seating ${product.seats}` : null,
      product.delivery_days !== null ? `with a ${product.delivery_days}-day delivery estimate` : null,
    ].filter(Boolean);
    sentences.push(`${parts.join(", ")}. It is ${inventoryLabel(product.inventory_status)}.`);
    sentences.push("I can only answer from the merchant's verified listing details; I couldn't find a specific answer to that question.");
    addFact(`Price: ${formatCents(product.price_cents)}`);
    if (product.material) addFact(`Material: ${product.material}`);
    if (product.seats !== null) addFact(`Seats ${product.seats}`);
    if (product.delivery_days !== null) addFact(`Listed delivery estimate: ${product.delivery_days} days`);
    addFact(`Inventory status: ${inventoryLabel(product.inventory_status)}`);
    addMissing("A verified answer to the specific question asked");
  }

  return { answer: sentences.join(" "), verified_facts: facts, missing_information: missing, topics, simulated: true };
}

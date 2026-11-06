// Deterministic product matching against parsed constraints.
//
// Rules:
//  - A product that VIOLATES any hard requirement is never a match.
//  - A product whose attribute is MISSING cannot verify that requirement; it is
//    not silently passed. It is returned (if nothing else fails) with
//    `verified: false` and the requirement listed in `unknown_requirements`.
//  - Out-of-stock products are not eligible.
//  - Ranking is fully deterministic (no randomness, stable tie-breakers).

import { CATEGORY_FAMILIES, keywordTokens } from "./parser.ts";
import type { Merchant, Product, SearchConstraints } from "./types.ts";

export function formatCents(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return `$${dollars.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
}

export interface Evaluation {
  match_reasons: string[];
  unknown_requirements: string[];
  failed_requirements: string[];
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

export function categoryMatches(productCategory: string, wanted: string): boolean {
  const p = norm(productCategory);
  const w = norm(wanted);
  if (p === w) return true;
  const family = CATEGORY_FAMILIES[wanted];
  return Boolean(family && p.endsWith(family));
}

export function evaluateProduct(product: Product, c: SearchConstraints, query = ""): Evaluation {
  const reasons: string[] = [];
  const unknown: string[] = [];
  const failed: string[] = [];

  if (c.category !== null) {
    if (categoryMatches(product.category, c.category)) {
      reasons.push(`Category is ${product.category}, matching the requested ${c.category}.`);
    } else {
      failed.push(`Category is ${product.category}, not ${c.category}.`);
    }
  }

  if (c.material !== null) {
    if (product.material === null || norm(product.material) === "") {
      unknown.push(`Material is not listed, so the ${c.material} requirement cannot be verified.`);
    } else if (norm(product.material) === c.material) {
      const solid = /\bsolid\b/i.test(query) && /\bsolid\b/i.test(product.description ?? "");
      reasons.push(
        solid
          ? `Material is ${product.material}; the merchant describes it as solid ${product.material}.`
          : `Material is ${product.material}, matching the requested ${c.material}.`,
      );
    } else {
      failed.push(`Material is ${product.material}, not ${c.material}.`);
    }
  }

  if (c.max_price_cents !== null) {
    const budget = formatCents(c.max_price_cents);
    if (product.price_cents <= c.max_price_cents) {
      reasons.push(`Price is ${formatCents(product.price_cents)}, within the ${budget} budget.`);
    } else {
      failed.push(`Price is ${formatCents(product.price_cents)}, above the ${budget} budget.`);
    }
  }

  if (c.minimum_seats !== null) {
    if (product.seats === null) {
      unknown.push(`Seating capacity is not listed, so the ${c.minimum_seats}-seat requirement cannot be verified.`);
    } else if (product.seats >= c.minimum_seats) {
      reasons.push(`Seats ${product.seats}, meeting the requirement of at least ${c.minimum_seats}.`);
    } else {
      failed.push(`Seats ${product.seats}, fewer than the required ${c.minimum_seats}.`);
    }
  }

  if (c.max_delivery_days !== null) {
    if (product.delivery_days === null) {
      unknown.push(`Delivery estimate is not listed, so delivery within ${c.max_delivery_days} days cannot be verified.`);
    } else if (product.delivery_days <= c.max_delivery_days) {
      reasons.push(`Listed delivery estimate is ${product.delivery_days} days, within ${c.max_delivery_days} days.`);
    } else {
      failed.push(`Listed delivery estimate is ${product.delivery_days} days, longer than ${c.max_delivery_days} days.`);
    }
  }

  if (product.inventory_status === "out_of_stock") {
    failed.push("Currently out of stock.");
  } else if (product.inventory_status === "in_stock") {
    reasons.push("In stock.");
  } else {
    reasons.push(`Inventory status: ${product.inventory_status.replace(/_/g, " ")}.`);
  }

  return { match_reasons: reasons, unknown_requirements: unknown, failed_requirements: failed };
}

export interface MatchResult {
  merchant: Merchant;
  product: Product;
  match_reasons: string[];
  unknown_requirements: string[];
  verified: boolean;
}

export interface AlternativeResult {
  merchant: Merchant;
  product: Product;
  match_reasons: string[];
  failed_requirements: string[];
  unknown_requirements: string[];
}

export interface RankedSearch {
  matches: MatchResult[];
  alternatives: AlternativeResult[];
}

const MAX_MATCHES = 20;
const MAX_ALTERNATIVES = 5;

function compareProducts(a: Product, b: Product): number {
  if (a.price_cents !== b.price_cents) return a.price_cents - b.price_cents;
  const ad = a.delivery_days ?? Number.MAX_SAFE_INTEGER;
  const bd = b.delivery_days ?? Number.MAX_SAFE_INTEGER;
  if (ad !== bd) return ad - bd;
  const byName = a.name.localeCompare(b.name);
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/**
 * Rank products from PUBLISHED merchants only. The caller is responsible for
 * passing published merchants; this function also re-checks the flag.
 */
export function rankProducts(
  merchants: Merchant[],
  products: Product[],
  constraints: SearchConstraints,
  query: string,
  useKeywordFallback: boolean,
): RankedSearch {
  const byId = new Map(merchants.filter((m) => m.published).map((m) => [m.id, m]));
  const tokens = useKeywordFallback ? keywordTokens(query) : [];

  const matches: MatchResult[] = [];
  const alternatives: AlternativeResult[] = [];

  for (const product of products) {
    const merchant = byId.get(product.merchant_id);
    if (!merchant) continue; // never surface unpublished merchants

    if (tokens.length > 0) {
      const hay = `${product.name} ${product.description ?? ""} ${product.category} ${product.material ?? ""}`.toLowerCase();
      const hits = tokens.filter((t) => hay.includes(t));
      if (hits.length === 0) continue;
    }

    const ev = evaluateProduct(product, constraints, query);
    if (ev.failed_requirements.length === 0) {
      matches.push({
        merchant,
        product,
        match_reasons: ev.match_reasons,
        unknown_requirements: ev.unknown_requirements,
        verified: ev.unknown_requirements.length === 0,
      });
    } else {
      // Near misses: same category (when one was requested) and at most two failures.
      const categoryOk = constraints.category === null || categoryMatches(product.category, constraints.category);
      if (categoryOk && ev.failed_requirements.length <= 2) {
        alternatives.push({
          merchant,
          product,
          match_reasons: ev.match_reasons,
          failed_requirements: ev.failed_requirements,
          unknown_requirements: ev.unknown_requirements,
        });
      }
    }
  }

  matches.sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    const du = a.unknown_requirements.length - b.unknown_requirements.length;
    return du !== 0 ? du : compareProducts(a.product, b.product);
  });
  alternatives.sort((a, b) => {
    const df = a.failed_requirements.length - b.failed_requirements.length;
    return df !== 0 ? df : compareProducts(a.product, b.product);
  });

  return { matches: matches.slice(0, MAX_MATCHES), alternatives: alternatives.slice(0, MAX_ALTERNATIVES) };
}

// Welcome API operations. All authorization is enforced here, server-side.
//
// Visibility rule: a merchant (and its products) is visible to a requester iff
// it is published OR the requester owns it. Invisible merchants are reported
// as MERCHANT_NOT_FOUND so their existence is not leaked.
// Discovery (searchProducts) only ever includes PUBLISHED merchants.

import { answerQuestion } from "./agent.ts";
import { WelcomeError } from "./errors.ts";
import { rankProducts } from "./matcher.ts";
import { hasAnyConstraint, parseConstraints } from "./parser.ts";
import type { ProductFields, WelcomeStore } from "./store.ts";
import type { ActivityEvent, Merchant, Product, PublicMerchant, RequestContext } from "./types.ts";
import {
  asPayload,
  inventoryStatus,
  optionalInt,
  optionalString,
  optionalUrl,
  requiredBoolean,
  requiredInt,
  requiredString,
  requiredUuid,
} from "./validation.ts";

/** Repeated identical checkout requests within this window return the same intent. */
export const CHECKOUT_DEDUPE_WINDOW_MS = 30_000;

export function toPublicMerchant(m: Merchant, ctx: RequestContext): PublicMerchant {
  const { owner_user_id, ...rest } = m;
  return { ...rest, is_owner: ctx.user !== null && owner_user_id === ctx.user.id };
}

function isOwner(m: Merchant, ctx: RequestContext): boolean {
  return ctx.user !== null && m.owner_user_id === ctx.user.id;
}

function requireUser(ctx: RequestContext) {
  if (!ctx.user) throw new WelcomeError("UNAUTHENTICATED", "Sign in as a merchant to perform this action.");
  return ctx.user;
}

function byName(a: { name: string; id: string }, b: { name: string; id: string }) {
  const n = a.name.localeCompare(b.name);
  return n !== 0 ? n : a.id.localeCompare(b.id);
}

export class WelcomeService {
  private store: WelcomeStore;
  private clock: () => Date;

  constructor(store: WelcomeStore, clock: () => Date = () => new Date()) {
    this.store = store;
    this.clock = clock;
  }

  /** Best-effort audit logging; never fails the user's request. */
  private async log(events: ActivityEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.store.logEvents(events);
    } catch (err) {
      console.error("activity log failed", err instanceof Error ? err.message : err);
    }
  }

  private async loadVisibleMerchant(merchantId: string, ctx: RequestContext): Promise<Merchant> {
    const m = await this.store.getMerchant(merchantId);
    if (!m || (!m.published && !isOwner(m, ctx))) {
      throw new WelcomeError("MERCHANT_NOT_FOUND", "Merchant not found.");
    }
    return m;
  }

  private async loadOwnedMerchant(merchantId: string, ctx: RequestContext): Promise<Merchant> {
    const user = requireUser(ctx);
    const m = await this.store.getMerchant(merchantId);
    if (!m || (!m.published && m.owner_user_id !== user.id)) {
      throw new WelcomeError("MERCHANT_NOT_FOUND", "Merchant not found.");
    }
    if (m.owner_user_id !== user.id) {
      throw new WelcomeError("FORBIDDEN", "Only the merchant's owner can modify this merchant.");
    }
    return m;
  }

  private async loadProductForMerchant(merchant: Merchant, productId: string): Promise<Product> {
    const p = await this.store.getProduct(productId);
    if (!p) throw new WelcomeError("PRODUCT_NOT_FOUND", "Product not found.");
    if (p.merchant_id !== merchant.id) {
      throw new WelcomeError("PRODUCT_MERCHANT_MISMATCH", "This product does not belong to the selected merchant.");
    }
    return p;
  }

  // -- Action 1 -------------------------------------------------------------
  async listMerchants(ctx: RequestContext, _raw: unknown) {
    const published = await this.store.listPublishedMerchants();
    const owned = ctx.user ? await this.store.listMerchantsByOwner(ctx.user.id) : [];
    const all = new Map<string, Merchant>();
    for (const m of [...published, ...owned]) all.set(m.id, m);
    const merchants = [...all.values()].sort(byName);
    const products = await this.store.listProductsByMerchantIds(merchants.map((m) => m.id));
    const counts = new Map<string, number>();
    for (const p of products) counts.set(p.merchant_id, (counts.get(p.merchant_id) ?? 0) + 1);
    return {
      merchants: merchants.map((m) => ({ ...toPublicMerchant(m, ctx), product_count: counts.get(m.id) ?? 0 })),
    };
  }

  // -- Action 2 -------------------------------------------------------------
  async getMerchant(ctx: RequestContext, raw: unknown) {
    const p = asPayload(raw);
    const merchant = await this.loadVisibleMerchant(requiredUuid(p, "merchant_id"), ctx);
    const products = (await this.store.listProductsByMerchantIds([merchant.id])).sort(byName);
    return { merchant: toPublicMerchant(merchant, ctx), products };
  }

  // -- Action 3 -------------------------------------------------------------
  async createMerchant(ctx: RequestContext, raw: unknown) {
    const user = requireUser(ctx);
    const p = asPayload(raw);
    const merchant = await this.store.insertMerchant({
      name: requiredString(p, "name", 120),
      description: optionalString(p, "description", 2000),
      category: optionalString(p, "category", 80),
      website: optionalUrl(p, "website", { httpsOnly: false }),
      owner_user_id: user.id,
    });
    await this.log([{ merchant_id: merchant.id, product_id: null, event_type: "merchant_created", metadata: {} }]);
    return { merchant: toPublicMerchant(merchant, ctx) };
  }

  // -- Action 4 -------------------------------------------------------------
  /**
   * Adds a product to a merchant the caller owns. Idempotent by name: if the
   * merchant already has a product with the same (case-insensitive) name, that
   * product is updated instead of duplicated, and `created` is false.
   */
  async addProduct(ctx: RequestContext, raw: unknown) {
    const p = asPayload(raw);
    const merchantId = requiredUuid(p, "merchant_id");
    const fields: ProductFields = {
      name: requiredString(p, "name", 160),
      description: optionalString(p, "description", 2000),
      category: requiredString(p, "category", 80),
      material: optionalString(p, "material", 60)?.toLowerCase() ?? null,
      seats: optionalInt(p, "seats", 1, 100),
      price_cents: requiredInt(p, "price_cents", 0, 100_000_000),
      delivery_days: optionalInt(p, "delivery_days", 0, 365),
      inventory_status: inventoryStatus(p, "inventory_status"),
      checkout_url: optionalUrl(p, "checkout_url", { httpsOnly: true }),
    };
    const merchant = await this.loadOwnedMerchant(merchantId, ctx);

    const existing = await this.store.findProductByName(merchant.id, fields.name);
    const product = existing
      ? await this.store.updateProduct(existing.id, fields)
      : await this.store.insertProduct(merchant.id, fields);
    await this.log([{
      merchant_id: merchant.id,
      product_id: product.id,
      event_type: existing ? "product_updated" : "product_added",
      metadata: {},
    }]);
    return { product, created: !existing };
  }

  // -- Action 5 -------------------------------------------------------------
  async setPublished(ctx: RequestContext, raw: unknown) {
    const p = asPayload(raw);
    const merchantId = requiredUuid(p, "merchant_id");
    const published = requiredBoolean(p, "published");
    await this.loadOwnedMerchant(merchantId, ctx);
    const merchant = await this.store.setMerchantPublished(merchantId, published);
    await this.log([{
      merchant_id: merchant.id,
      product_id: null,
      event_type: published ? "merchant_published" : "merchant_unpublished",
      metadata: {},
    }]);
    return { merchant: toPublicMerchant(merchant, ctx) };
  }

  // -- Action 6 -------------------------------------------------------------
  /** Public discovery: PUBLISHED merchants only, for every requester. */
  async searchProducts(ctx: RequestContext, raw: unknown) {
    const p = asPayload(raw);
    const query = requiredString(p, "query", 500);
    const constraints = parseConstraints(query);

    const merchants = await this.store.listPublishedMerchants();
    const products = await this.store.listProductsByMerchantIds(merchants.map((m) => m.id));
    const ranked = rankProducts(merchants, products, constraints, query, !hasAnyConstraint(constraints));

    const pub = (m: Merchant) => toPublicMerchant(m, ctx);
    const matches = ranked.matches.map((r) => ({ ...r, merchant: pub(r.merchant) }));
    const alternatives = ranked.alternatives.map((r) => ({ ...r, merchant: pub(r.merchant) }));

    await this.log(ranked.matches.map((r) => ({
      merchant_id: r.merchant.id,
      product_id: r.product.id,
      event_type: "product_discovered" as const,
      metadata: { verified: r.verified },
    })));

    return {
      query,
      constraints,
      matches,
      alternatives,
      total_matches: matches.length,
    };
  }

  // -- Action 7 -------------------------------------------------------------
  async askMerchant(ctx: RequestContext, raw: unknown) {
    const p = asPayload(raw);
    const merchantId = requiredUuid(p, "merchant_id");
    const productId = requiredUuid(p, "product_id");
    const question = requiredString(p, "question", 500);

    const merchant = await this.loadVisibleMerchant(merchantId, ctx);
    const product = await this.loadProductForMerchant(merchant, productId);
    const result = answerQuestion(merchant, product, question);

    // Only topic labels are logged, never the shopper's raw question text.
    await this.log([{
      merchant_id: merchant.id,
      product_id: product.id,
      event_type: "agent_question_asked",
      metadata: { topics: result.topics },
    }]);

    return {
      merchant_id: merchant.id,
      product_id: product.id,
      answer: result.answer,
      verified_facts: result.verified_facts,
      missing_information: result.missing_information,
      simulated: true as const,
    };
  }

  // -- Action 8 -------------------------------------------------------------
  /** Creates a SIMULATED checkout handoff record. No payment is processed. */
  async createCheckoutIntent(ctx: RequestContext, raw: unknown) {
    const p = asPayload(raw);
    const merchantId = requiredUuid(p, "merchant_id");
    const productId = requiredUuid(p, "product_id");
    const idempotencyKey = optionalString(p, "idempotency_key", 128);
    if (idempotencyKey !== null && idempotencyKey.length < 8) {
      throw new WelcomeError("VALIDATION_ERROR", "idempotency_key: must be at least 8 characters", {
        field: "idempotency_key",
      });
    }

    const merchant = await this.loadVisibleMerchant(merchantId, ctx);
    if (!merchant.published) {
      throw new WelcomeError("MERCHANT_NOT_PUBLISHED", "Publish this merchant before creating checkout handoffs.");
    }
    const product = await this.loadProductForMerchant(merchant, productId);
    if (product.inventory_status === "out_of_stock") {
      throw new WelcomeError("PRODUCT_UNAVAILABLE", "This product is out of stock.");
    }

    const requester = ctx.user?.id ?? null;
    let existing = idempotencyKey
      ? await this.store.findCheckoutIntentByKey(product.id, idempotencyKey)
      : await this.store.findRecentCheckoutIntent(
        product.id,
        requester,
        new Date(this.clock().getTime() - CHECKOUT_DEDUPE_WINDOW_MS).toISOString(),
      );

    const deduplicated = existing !== null;
    if (!existing) {
      existing = await this.store.insertCheckoutIntent({
        merchant_id: merchant.id,
        product_id: product.id,
        // Only a checkout URL the merchant configured on the product is ever returned.
        checkout_url: product.checkout_url,
        requester_user_id: requester,
        idempotency_key: idempotencyKey,
      });
      await this.log([{
        merchant_id: merchant.id,
        product_id: product.id,
        event_type: "checkout_handoff_created",
        metadata: { has_checkout_url: product.checkout_url !== null },
      }]);
    }

    return {
      checkout_intent_id: existing.id,
      status: existing.status,
      checkout_url: existing.checkout_url,
      merchant_id: merchant.id,
      product_id: product.id,
      amount_cents: product.price_cents,
      payment_processed: false as const,
      simulated: true as const,
      deduplicated,
      created_at: existing.created_at,
      message: existing.checkout_url
        ? "Checkout handoff created. Complete the purchase on the merchant's checkout page. No payment has been taken."
        : "Simulated checkout handoff created. The merchant has no checkout link configured; no order or payment exists.",
    };
  }
}

export const ACTIONS = [
  "listMerchants",
  "getMerchant",
  "createMerchant",
  "addProduct",
  "setPublished",
  "searchProducts",
  "askMerchant",
  "createCheckoutIntent",
] as const;
export type ActionName = typeof ACTIONS[number];

export function isAction(a: unknown): a is ActionName {
  return typeof a === "string" && (ACTIONS as readonly string[]).includes(a);
}

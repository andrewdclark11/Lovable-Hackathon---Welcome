// Postgres-backed store using supabase-js (parameterised queries; no raw SQL).
// Runs with the service-role client INSIDE the Edge Function only; authorization
// is enforced by WelcomeService before any call reaches this layer, and RLS
// remains enabled for any direct client access.

import type { NewCheckoutIntent, NewMerchant, ProductFields, WelcomeStore } from "./store.ts";
import type { ActivityEvent, CheckoutIntent, Merchant, Product } from "./types.ts";

// Minimal structural type so this module does not import supabase-js directly.
// deno-lint-ignore no-explicit-any
type SupabaseClientLike = { from: (table: string) => any };

interface PgResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

function unwrap<T>(res: PgResult<T>, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

const MERCHANT_COLS = "id,name,description,category,website,published,owner_user_id,created_at,updated_at";
const PRODUCT_COLS =
  "id,merchant_id,name,description,category,material,seats,price_cents,delivery_days,inventory_status,checkout_url,created_at,updated_at";
const INTENT_COLS = "id,merchant_id,product_id,status,checkout_url,requester_user_id,idempotency_key,created_at";

export class SupabaseStore implements WelcomeStore {
  private db: SupabaseClientLike;

  constructor(db: SupabaseClientLike) {
    this.db = db;
  }

  async listPublishedMerchants(): Promise<Merchant[]> {
    return unwrap(await this.db.from("merchants").select(MERCHANT_COLS).eq("published", true), "listPublishedMerchants");
  }

  async listMerchantsByOwner(ownerUserId: string): Promise<Merchant[]> {
    return unwrap(await this.db.from("merchants").select(MERCHANT_COLS).eq("owner_user_id", ownerUserId), "listMerchantsByOwner");
  }

  async getMerchant(id: string): Promise<Merchant | null> {
    return unwrap(await this.db.from("merchants").select(MERCHANT_COLS).eq("id", id).maybeSingle(), "getMerchant");
  }

  async insertMerchant(input: NewMerchant): Promise<Merchant> {
    return unwrap(await this.db.from("merchants").insert(input).select(MERCHANT_COLS).single(), "insertMerchant");
  }

  async setMerchantPublished(id: string, published: boolean): Promise<Merchant> {
    return unwrap(
      await this.db.from("merchants").update({ published }).eq("id", id).select(MERCHANT_COLS).single(),
      "setMerchantPublished",
    );
  }

  async listProductsByMerchantIds(merchantIds: string[]): Promise<Product[]> {
    if (merchantIds.length === 0) return [];
    return unwrap(
      await this.db.from("products").select(PRODUCT_COLS).in("merchant_id", merchantIds),
      "listProductsByMerchantIds",
    );
  }

  async getProduct(id: string): Promise<Product | null> {
    return unwrap(await this.db.from("products").select(PRODUCT_COLS).eq("id", id).maybeSingle(), "getProduct");
  }

  async findProductByName(merchantId: string, name: string): Promise<Product | null> {
    // ilike with escaped wildcards == case-insensitive equality.
    const escaped = name.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows: Product[] = unwrap(
      await this.db.from("products").select(PRODUCT_COLS).eq("merchant_id", merchantId).ilike("name", escaped).limit(1),
      "findProductByName",
    );
    return rows[0] ?? null;
  }

  async insertProduct(merchantId: string, fields: ProductFields): Promise<Product> {
    return unwrap(
      await this.db.from("products").insert({ ...fields, merchant_id: merchantId }).select(PRODUCT_COLS).single(),
      "insertProduct",
    );
  }

  async updateProduct(id: string, fields: ProductFields): Promise<Product> {
    return unwrap(
      await this.db.from("products").update(fields).eq("id", id).select(PRODUCT_COLS).single(),
      "updateProduct",
    );
  }

  async findCheckoutIntentByKey(productId: string, key: string): Promise<CheckoutIntent | null> {
    return unwrap(
      await this.db.from("checkout_intents").select(INTENT_COLS).eq("product_id", productId).eq("idempotency_key", key)
        .maybeSingle(),
      "findCheckoutIntentByKey",
    );
  }

  async findRecentCheckoutIntent(productId: string, requester: string | null, sinceIso: string) {
    let q = this.db.from("checkout_intents").select(INTENT_COLS)
      .eq("product_id", productId)
      .eq("status", "demo_created")
      .is("idempotency_key", null)
      .gte("created_at", sinceIso);
    q = requester === null ? q.is("requester_user_id", null) : q.eq("requester_user_id", requester);
    const rows: CheckoutIntent[] = unwrap(await q.order("created_at", { ascending: false }).limit(1), "findRecentCheckoutIntent");
    return rows[0] ?? null;
  }

  async insertCheckoutIntent(input: NewCheckoutIntent): Promise<CheckoutIntent> {
    return unwrap(
      await this.db.from("checkout_intents").insert({ ...input, status: "demo_created" }).select(INTENT_COLS).single(),
      "insertCheckoutIntent",
    );
  }

  async logEvents(events: ActivityEvent[]): Promise<void> {
    if (events.length === 0) return;
    unwrap(await this.db.from("activity_events").insert(events), "logEvents");
  }
}

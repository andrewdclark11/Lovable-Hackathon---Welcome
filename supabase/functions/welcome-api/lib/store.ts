// deno-lint-ignore-file require-await
// Persistence port. The service layer depends only on this interface, so domain
// logic is testable with the in-memory store and runs on Postgres in production.

import type { ActivityEvent, CheckoutIntent, InventoryStatus, Merchant, Product } from "./types.ts";

export interface NewMerchant {
  name: string;
  description: string | null;
  category: string | null;
  website: string | null;
  owner_user_id: string;
}

export interface ProductFields {
  name: string;
  description: string | null;
  category: string;
  material: string | null;
  seats: number | null;
  price_cents: number;
  delivery_days: number | null;
  inventory_status: InventoryStatus;
  checkout_url: string | null;
}

export interface NewCheckoutIntent {
  merchant_id: string;
  product_id: string;
  checkout_url: string | null;
  requester_user_id: string | null;
  idempotency_key: string | null;
}

export interface WelcomeStore {
  listPublishedMerchants(): Promise<Merchant[]>;
  listMerchantsByOwner(ownerUserId: string): Promise<Merchant[]>;
  getMerchant(id: string): Promise<Merchant | null>;
  insertMerchant(input: NewMerchant): Promise<Merchant>;
  setMerchantPublished(id: string, published: boolean): Promise<Merchant>;

  listProductsByMerchantIds(merchantIds: string[]): Promise<Product[]>;
  getProduct(id: string): Promise<Product | null>;
  findProductByName(merchantId: string, name: string): Promise<Product | null>;
  insertProduct(merchantId: string, fields: ProductFields): Promise<Product>;
  updateProduct(id: string, fields: ProductFields): Promise<Product>;

  findCheckoutIntentByKey(productId: string, idempotencyKey: string): Promise<CheckoutIntent | null>;
  findRecentCheckoutIntent(
    productId: string,
    requesterUserId: string | null,
    sinceIso: string,
  ): Promise<CheckoutIntent | null>;
  insertCheckoutIntent(input: NewCheckoutIntent): Promise<CheckoutIntent>;

  logEvents(events: ActivityEvent[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests, local development).
// ---------------------------------------------------------------------------

export class InMemoryStore implements WelcomeStore {
  merchants = new Map<string, Merchant>();
  products = new Map<string, Product>();
  intents: CheckoutIntent[] = [];
  events: ActivityEvent[] = [];
  private clock: () => Date;
  private seq = 0;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private uuid(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${this.seq.toString(16).padStart(12, "0")}`;
  }

  async listPublishedMerchants(): Promise<Merchant[]> {
    return [...this.merchants.values()].filter((m) => m.published).map((m) => ({ ...m }));
  }

  async listMerchantsByOwner(ownerUserId: string): Promise<Merchant[]> {
    return [...this.merchants.values()].filter((m) => m.owner_user_id === ownerUserId).map((m) => ({ ...m }));
  }

  async getMerchant(id: string): Promise<Merchant | null> {
    const m = this.merchants.get(id);
    return m ? { ...m } : null;
  }

  async insertMerchant(input: NewMerchant): Promise<Merchant> {
    const now = this.now();
    const m: Merchant = { id: this.uuid(), published: false, created_at: now, updated_at: now, ...input };
    this.merchants.set(m.id, m);
    return { ...m };
  }

  async setMerchantPublished(id: string, published: boolean): Promise<Merchant> {
    const m = this.merchants.get(id);
    if (!m) throw new Error("merchant not found");
    m.published = published;
    m.updated_at = this.now();
    return { ...m };
  }

  async listProductsByMerchantIds(merchantIds: string[]): Promise<Product[]> {
    const ids = new Set(merchantIds);
    return [...this.products.values()].filter((p) => ids.has(p.merchant_id)).map((p) => ({ ...p }));
  }

  async getProduct(id: string): Promise<Product | null> {
    const p = this.products.get(id);
    return p ? { ...p } : null;
  }

  async findProductByName(merchantId: string, name: string): Promise<Product | null> {
    const n = name.toLowerCase();
    const p = [...this.products.values()].find((x) => x.merchant_id === merchantId && x.name.toLowerCase() === n);
    return p ? { ...p } : null;
  }

  async insertProduct(merchantId: string, fields: ProductFields): Promise<Product> {
    const now = this.now();
    const p: Product = { id: this.uuid(), merchant_id: merchantId, created_at: now, updated_at: now, ...fields };
    this.products.set(p.id, p);
    return { ...p };
  }

  async updateProduct(id: string, fields: ProductFields): Promise<Product> {
    const p = this.products.get(id);
    if (!p) throw new Error("product not found");
    Object.assign(p, fields, { updated_at: this.now() });
    return { ...p };
  }

  async findCheckoutIntentByKey(productId: string, key: string): Promise<CheckoutIntent | null> {
    return this.intents.find((i) => i.product_id === productId && i.idempotency_key === key) ?? null;
  }

  async findRecentCheckoutIntent(productId: string, requester: string | null, sinceIso: string) {
    const hits = this.intents
      .filter((i) =>
        i.product_id === productId && i.requester_user_id === requester && i.idempotency_key === null &&
        i.status === "demo_created" && i.created_at >= sinceIso
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return hits[0] ?? null;
  }

  async insertCheckoutIntent(input: NewCheckoutIntent): Promise<CheckoutIntent> {
    const intent: CheckoutIntent = { id: this.uuid(), status: "demo_created", created_at: this.now(), ...input };
    this.intents.push(intent);
    return { ...intent };
  }

  async logEvents(events: ActivityEvent[]): Promise<void> {
    this.events.push(...events);
  }

  /** Test helpers: insert fixtures with explicit IDs. */
  putMerchant(m: Merchant): void {
    this.merchants.set(m.id, { ...m });
  }
  putProduct(p: Product): void {
    this.products.set(p.id, { ...p });
  }
}

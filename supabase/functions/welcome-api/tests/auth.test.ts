import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  anon,
  DEMO_OWNER,
  EAST_HARBOR,
  NORTHLINE,
  other,
  owner,
  seededHarness,
} from "./helpers.ts";

const newProduct = (merchant_id: string) => ({
  merchant_id,
  name: "Walnut Side Table",
  description: "Small solid walnut side table",
  category: "Side Tables",
  material: "Walnut",
  price_cents: 34900,
  delivery_days: 7,
  inventory_status: "in_stock",
});

describe("authorization: publishing", () => {
  it("anonymous users cannot publish", async () => {
    const { service } = seededHarness();
    await assert.rejects(service.setPublished(anon, { merchant_id: NORTHLINE, published: true }), {
      code: "UNAUTHENTICATED",
    });
  });

  it("other users cannot publish someone else's unpublished merchant (and learn nothing)", async () => {
    const { service, store } = seededHarness();
    await assert.rejects(service.setPublished(other, { merchant_id: NORTHLINE, published: true }), {
      code: "MERCHANT_NOT_FOUND",
    });
    assert.equal(store.merchants.get(NORTHLINE)?.published, false);
  });

  it("other users cannot unpublish a published merchant they don't own", async () => {
    const { service, store } = seededHarness();
    await assert.rejects(service.setPublished(other, { merchant_id: EAST_HARBOR, published: false }), {
      code: "FORBIDDEN",
    });
    assert.equal(store.merchants.get(EAST_HARBOR)?.published, true);
  });

  it("seeded example merchants are read-only even for the demo owner", async () => {
    const { service } = seededHarness();
    await assert.rejects(service.setPublished(owner, { merchant_id: EAST_HARBOR, published: false }), {
      code: "FORBIDDEN",
    });
  });

  it("the owner can publish and the change is persisted + logged", async () => {
    const { service, store } = seededHarness();
    const r = await service.setPublished(owner, { merchant_id: NORTHLINE, published: true });
    assert.equal(r.merchant.published, true);
    assert.equal(r.merchant.is_owner, true);
    assert.equal(store.merchants.get(NORTHLINE)?.published, true);
    assert.ok(store.events.some((e) => e.event_type === "merchant_published" && e.merchant_id === NORTHLINE));
  });

  it("validates the published flag type", async () => {
    const { service } = seededHarness();
    await assert.rejects(service.setPublished(owner, { merchant_id: NORTHLINE, published: "yes" }), {
      code: "VALIDATION_ERROR",
    });
  });
});

describe("authorization: products", () => {
  it("anonymous users cannot add products", async () => {
    const { service } = seededHarness();
    await assert.rejects(service.addProduct(anon, newProduct(NORTHLINE)), { code: "UNAUTHENTICATED" });
  });

  it("other users cannot add products to another merchant", async () => {
    const { service, store } = seededHarness();
    const before = store.products.size;
    await assert.rejects(service.addProduct(other, newProduct(EAST_HARBOR)), { code: "FORBIDDEN" });
    await assert.rejects(service.addProduct(other, newProduct(NORTHLINE)), { code: "MERCHANT_NOT_FOUND" });
    assert.equal(store.products.size, before);
  });

  it("owners can add products; material is normalised; re-adding by name updates instead of duplicating", async () => {
    const { service, store } = seededHarness();
    const before = store.products.size;
    const a = await service.addProduct(owner, newProduct(NORTHLINE));
    assert.equal(a.created, true);
    assert.equal(a.product.material, "walnut");
    const b = await service.addProduct(owner, { ...newProduct(NORTHLINE), name: "walnut side TABLE", price_cents: 32900 });
    assert.equal(b.created, false);
    assert.equal(b.product.id, a.product.id);
    assert.equal(b.product.price_cents, 32900);
    assert.equal(store.products.size, before + 1);
  });

  it("validates price, seats and other field types", async () => {
    const { service } = seededHarness();
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ price_cents: 1299.5 }, "price_cents"],
      [{ price_cents: -1 }, "price_cents"],
      [{ price_cents: "129900" }, "price_cents"],
      [{ seats: 0 }, "seats"],
      [{ delivery_days: 3.5 }, "delivery_days"],
      [{ inventory_status: "teleporting" }, "inventory_status"],
      [{ checkout_url: "http://insecure.example/x" }, "checkout_url"],
      [{ checkout_url: "javascript:alert(1)" }, "checkout_url"],
      [{ name: "" }, "name"],
      [{ merchant_id: "'; drop table merchants; --" }, "merchant_id"],
    ];
    for (const [patch, field] of bad) {
      await assert.rejects(service.addProduct(owner, { ...newProduct(NORTHLINE), ...patch }), (err: { code: string; details?: { field: string } }) => {
        assert.equal(err.code, "VALIDATION_ERROR", JSON.stringify(patch));
        assert.equal(err.details?.field, field);
        return true;
      });
    }
  });
});

describe("authorization: merchant registry visibility", () => {
  it("public listMerchants returns only published merchants without owner ids", async () => {
    const { service } = seededHarness();
    const r = await service.listMerchants(anon, {});
    assert.deepEqual(r.merchants.map((m) => m.name), ["East Harbor Living", "Hearth & Home Studio"]);
    for (const m of r.merchants) assert.ok(!("owner_user_id" in m));
  });

  it("the owner additionally sees their unpublished merchant", async () => {
    const { service } = seededHarness();
    const r = await service.listMerchants(owner, {});
    const northline = r.merchants.find((m) => m.id === NORTHLINE);
    assert.ok(northline);
    assert.equal(northline.is_owner, true);
    assert.equal(northline.published, false);
    assert.equal(northline.product_count, 5);
  });

  it("unrelated users cannot fetch an unpublished merchant", async () => {
    const { service } = seededHarness();
    await assert.rejects(service.getMerchant(anon, { merchant_id: NORTHLINE }), { code: "MERCHANT_NOT_FOUND" });
    await assert.rejects(service.getMerchant(other, { merchant_id: NORTHLINE }), { code: "MERCHANT_NOT_FOUND" });
    const mine = await service.getMerchant(owner, { merchant_id: NORTHLINE });
    assert.equal(mine.products.length, 5);
  });

  it("createMerchant requires auth, validates, and creates an unpublished merchant owned by the caller", async () => {
    const { service, store } = seededHarness();
    await assert.rejects(service.createMerchant(anon, { name: "X" }), { code: "UNAUTHENTICATED" });
    await assert.rejects(service.createMerchant(other, { name: "X", website: "ftp://x.example" }), {
      code: "VALIDATION_ERROR",
    });
    const r = await service.createMerchant(other, {
      name: "Pine & Co",
      description: "Pine furniture",
      category: "Furniture",
      website: "https://pine.example",
    });
    assert.equal(r.merchant.published, false);
    assert.equal(r.merchant.is_owner, true);
    assert.equal(store.merchants.get(r.merchant.id)?.owner_user_id, other.user?.id);
    assert.notEqual(store.merchants.get(r.merchant.id)?.owner_user_id, DEMO_OWNER.id);
  });
});

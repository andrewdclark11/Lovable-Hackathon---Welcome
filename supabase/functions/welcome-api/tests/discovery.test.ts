import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateProduct, rankProducts } from "../lib/matcher.ts";
import { parseConstraints } from "../lib/parser.ts";
import type { Merchant, Product } from "../lib/types.ts";
import {
  anon,
  COMPACT_WALNUT_TABLE,
  DEMO_QUERY,
  EAST_HARBOR,
  HARBOR_WALNUT_TABLE,
  HEARTH_OAK_TABLE,
  HEARTH_TRESTLE_TABLE,
  NORTHLINE,
  NORTHLINE_TABLE,
  owner,
  seededHarness,
} from "./helpers.ts";

describe("discovery: the demo before/after", () => {
  it("BEFORE publish: Northline is excluded and no product is fabricated as a match", async () => {
    const { service } = seededHarness();
    const res = await service.searchProducts(anon, { query: DEMO_QUERY });
    assert.equal(res.matches.length, 0);
    const merchantIds = [...res.matches, ...res.alternatives].map((r) => r.merchant.id);
    assert.ok(!merchantIds.includes(NORTHLINE), "unpublished merchant must not appear");
    // Near misses are explicitly labelled non-matching, each with a concrete failed requirement.
    const altIds = res.alternatives.map((a) => a.product.id).sort();
    assert.deepEqual(altIds, [HARBOR_WALNUT_TABLE, COMPACT_WALNUT_TABLE, HEARTH_OAK_TABLE, HEARTH_TRESTLE_TABLE].sort());
    for (const a of res.alternatives) assert.ok(a.failed_requirements.length > 0);
  });

  it("even the owner does not see their unpublished merchant in public discovery", async () => {
    const { service } = seededHarness();
    const res = await service.searchProducts(owner, { query: DEMO_QUERY });
    assert.ok(!res.matches.some((m) => m.merchant.id === NORTHLINE));
  });

  it("AFTER publish: the Northline walnut table is the verified match with real reasons", async () => {
    const { service } = seededHarness();
    await service.setPublished(owner, { merchant_id: NORTHLINE, published: true });
    const res = await service.searchProducts(anon, { query: DEMO_QUERY });
    assert.deepEqual(res.constraints, {
      category: "Dining Tables", material: "walnut", max_price_cents: 150000, minimum_seats: 6, max_delivery_days: 14,
    });
    assert.equal(res.matches.length, 1);
    const [m] = res.matches;
    assert.equal(m.product.id, NORTHLINE_TABLE);
    assert.equal(m.merchant.name, "Northline Furniture");
    assert.equal(m.verified, true);
    assert.deepEqual(m.unknown_requirements, []);
    const reasons = m.match_reasons.join(" ");
    assert.match(reasons, /Dining Tables/);
    assert.match(reasons, /solid walnut/);
    assert.match(reasons, /\$1,299\.00, within the \$1,500\.00 budget/);
    assert.match(reasons, /Seats 6/);
    assert.match(reasons, /10 days, within 14 days/);
    assert.ok(!("owner_user_id" in m.merchant), "owner id is never exposed");
  });

  it("unpublishing hides the merchant again", async () => {
    const { service } = seededHarness();
    await service.setPublished(owner, { merchant_id: NORTHLINE, published: true });
    await service.setPublished(owner, { merchant_id: NORTHLINE, published: false });
    const res = await service.searchProducts(anon, { query: DEMO_QUERY });
    assert.equal(res.matches.length, 0);
  });

  it("is deterministic across repeated calls", async () => {
    const { service } = seededHarness();
    await service.setPublished(owner, { merchant_id: NORTHLINE, published: true });
    const a = await service.searchProducts(anon, { query: "walnut table" });
    const b = await service.searchProducts(anon, { query: "walnut table" });
    assert.deepEqual(a.matches.map((x) => x.product.id), b.matches.map((x) => x.product.id));
  });

  it("logs product_discovered events for matches", async () => {
    const { service, store } = seededHarness();
    await service.setPublished(owner, { merchant_id: NORTHLINE, published: true });
    await service.searchProducts(anon, { query: DEMO_QUERY });
    assert.ok(store.events.some((e) => e.event_type === "product_discovered" && e.product_id === NORTHLINE_TABLE));
  });
});

describe("discovery: hard requirements", () => {
  const c = parseConstraints(DEMO_QUERY);
  const base: Product = {
    id: "p1", merchant_id: "m1", name: "Test Table", description: "Solid walnut table", category: "Dining Tables",
    material: "walnut", seats: 6, price_cents: 129900, delivery_days: 10, inventory_status: "in_stock",
    checkout_url: null, created_at: "", updated_at: "",
  };
  const merchant: Merchant = {
    id: "m1", name: "M", description: null, category: null, website: null, published: true, owner_user_id: null,
    created_at: "", updated_at: "",
  };

  it("excludes a product over budget", () => {
    const ev = evaluateProduct({ ...base, price_cents: 169900 }, c, DEMO_QUERY);
    assert.match(ev.failed_requirements.join(), /above the \$1,500\.00 budget/);
  });

  it("excludes the wrong material", () => {
    const ev = evaluateProduct({ ...base, material: "oak" }, c, DEMO_QUERY);
    assert.match(ev.failed_requirements.join(), /Material is oak, not walnut/);
  });

  it("excludes insufficient seating", () => {
    const ev = evaluateProduct({ ...base, seats: 4 }, c, DEMO_QUERY);
    assert.match(ev.failed_requirements.join(), /Seats 4, fewer than the required 6/);
  });

  it("excludes out-of-stock products", () => {
    const ev = evaluateProduct({ ...base, inventory_status: "out_of_stock" }, c, DEMO_QUERY);
    assert.ok(ev.failed_requirements.length > 0);
  });

  it("does not treat missing delivery information as verified", () => {
    const r = rankProducts([merchant], [{ ...base, delivery_days: null }], c, DEMO_QUERY, false);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].verified, false);
    assert.match(r.matches[0].unknown_requirements.join(), /Delivery estimate is not listed/);
    assert.ok(!r.matches[0].match_reasons.some((x) => /delivery/i.test(x)));
  });

  it("ranks verified matches before unverified ones, then by price", () => {
    const products: Product[] = [
      { ...base, id: "a", price_cents: 100000, delivery_days: null },
      { ...base, id: "b", price_cents: 140000 },
      { ...base, id: "c", price_cents: 120000 },
    ];
    const r = rankProducts([merchant], products, c, DEMO_QUERY, false);
    assert.deepEqual(r.matches.map((m) => m.product.id), ["c", "b", "a"]);
  });

  it("never returns products of unpublished merchants, even if passed in", () => {
    const r = rankProducts([{ ...merchant, published: false }], [base], c, DEMO_QUERY, false);
    assert.equal(r.matches.length, 0);
    assert.equal(r.alternatives.length, 0);
  });
});

describe("discovery: other queries use real catalog data", () => {
  it("finds East Harbor's sofa by category", async () => {
    const { service } = seededHarness();
    const res = await service.searchProducts(anon, { query: "a linen sofa under $2000" });
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0].merchant.id, EAST_HARBOR);
  });

  it("keyword fallback when no constraint is recognised", async () => {
    const { service } = seededHarness();
    const res = await service.searchProducts(anon, { query: "farmhouse" });
    assert.deepEqual(res.matches.map((m) => m.product.id), [HEARTH_OAK_TABLE]);
  });

  it("rejects an empty query", async () => {
    const { service } = seededHarness();
    await assert.rejects(service.searchProducts(anon, { query: "  " }), { code: "VALIDATION_ERROR" });
  });
});

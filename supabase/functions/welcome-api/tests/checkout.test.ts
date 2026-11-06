import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  anon,
  EAST_HARBOR,
  HARBOR_WALNUT_TABLE,
  NORTHLINE,
  NORTHLINE_TABLE,
  owner,
  seededHarness,
} from "./helpers.ts";

async function published() {
  const h = seededHarness();
  await h.service.setPublished(owner, { merchant_id: NORTHLINE, published: true });
  return h;
}

describe("createCheckoutIntent", () => {
  it("creates a persistent, simulated checkout intent for a valid selection", async () => {
    const { service, store } = await published();
    const r = await service.createCheckoutIntent(anon, { merchant_id: NORTHLINE, product_id: NORTHLINE_TABLE });
    assert.equal(r.status, "demo_created");
    assert.equal(r.checkout_url, null);
    assert.equal(r.simulated, true);
    assert.equal(r.payment_processed, false);
    assert.equal(r.deduplicated, false);
    assert.equal(store.intents.length, 1);
    assert.equal(store.intents[0].id, r.checkout_intent_id);
    assert.ok(store.events.some((e) => e.event_type === "checkout_handoff_created"));
  });

  it("never fabricates payment success", async () => {
    const { service } = await published();
    const r = await service.createCheckoutIntent(anon, { merchant_id: NORTHLINE, product_id: NORTHLINE_TABLE });
    const text = JSON.stringify(r).toLowerCase();
    assert.doesNotMatch(text, /"status":"(paid|completed|succeeded|confirmed)"/);
    assert.match(r.message, /no order or payment exists/i);
  });

  it("returns the merchant-configured checkout URL only when one exists", async () => {
    const { service } = await published();
    const r = await service.createCheckoutIntent(anon, { merchant_id: EAST_HARBOR, product_id: HARBOR_WALNUT_TABLE });
    assert.equal(r.checkout_url, "https://eastharbor.example/checkout/harbor-walnut-dining-table");
  });

  it("deduplicates accidental repeated requests", async () => {
    const { service, store, now } = await published();
    const a = await service.createCheckoutIntent(anon, { merchant_id: NORTHLINE, product_id: NORTHLINE_TABLE });
    const b = await service.createCheckoutIntent(anon, { merchant_id: NORTHLINE, product_id: NORTHLINE_TABLE });
    assert.equal(b.checkout_intent_id, a.checkout_intent_id);
    assert.equal(b.deduplicated, true);
    now.t += 60_000;
    const c = await service.createCheckoutIntent(anon, { merchant_id: NORTHLINE, product_id: NORTHLINE_TABLE });
    assert.notEqual(c.checkout_intent_id, a.checkout_intent_id);
    assert.equal(store.intents.length, 2);
  });

  it("honours an idempotency key", async () => {
    const { service, now } = await published();
    const p = { merchant_id: NORTHLINE, product_id: NORTHLINE_TABLE, idempotency_key: "demo-key-123" };
    const a = await service.createCheckoutIntent(anon, p);
    now.t += 10 * 60_000;
    const b = await service.createCheckoutIntent(anon, p);
    assert.equal(a.checkout_intent_id, b.checkout_intent_id);
  });

  it("rejects invalid and unknown product IDs", async () => {
    const { service } = await published();
    await assert.rejects(service.createCheckoutIntent(anon, { merchant_id: NORTHLINE, product_id: "nope" }), {
      code: "VALIDATION_ERROR",
    });
    await assert.rejects(
      service.createCheckoutIntent(anon, { merchant_id: NORTHLINE, product_id: "0b000000-0000-4000-8000-00000000ffff" }),
      { code: "PRODUCT_NOT_FOUND" },
    );
  });

  it("rejects product–merchant mismatches", async () => {
    const { service, store } = await published();
    await assert.rejects(
      service.createCheckoutIntent(anon, { merchant_id: NORTHLINE, product_id: HARBOR_WALNUT_TABLE }),
      { code: "PRODUCT_MERCHANT_MISMATCH" },
    );
    assert.equal(store.intents.length, 0);
  });

  it("rejects checkout for an unpublished merchant", async () => {
    const { service } = seededHarness();
    await assert.rejects(
      service.createCheckoutIntent(anon, { merchant_id: NORTHLINE, product_id: NORTHLINE_TABLE }),
      { code: "MERCHANT_NOT_FOUND" },
    );
    await assert.rejects(
      service.createCheckoutIntent(owner, { merchant_id: NORTHLINE, product_id: NORTHLINE_TABLE }),
      { code: "MERCHANT_NOT_PUBLISHED" },
    );
  });
});

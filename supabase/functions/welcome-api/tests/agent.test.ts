import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  anon,
  EAST_HARBOR,
  HARBOR_WALNUT_TABLE,
  HEARTH,
  HEARTH_OAK_TABLE,
  NORTHLINE,
  NORTHLINE_TABLE,
  other,
  owner,
  seededHarness,
} from "./helpers.ts";

async function publishedNorthline() {
  const h = seededHarness();
  await h.service.setPublished(owner, { merchant_id: NORTHLINE, published: true });
  return h;
}

const ask = (question: string) => ({ merchant_id: NORTHLINE, product_id: NORTHLINE_TABLE, question });

describe("askMerchant: grounded answers", () => {
  it("answers seating from the product's data", async () => {
    const { service } = await publishedNorthline();
    const r = await service.askMerchant(anon, ask("Does this table seat six?"));
    assert.equal(r.answer, "Yes. The Solid Walnut Dining Table seats 6 people.");
    assert.deepEqual(r.verified_facts, ["Seats 6"]);
    assert.deepEqual(r.missing_information, []);
    assert.equal(r.simulated, true);
  });

  it("answers delivery against the shopper's window", async () => {
    const { service } = await publishedNorthline();
    const r = await service.askMerchant(anon, ask("Can it arrive within two weeks?"));
    assert.equal(r.answer, "The listed delivery estimate is 10 days, which is within two weeks.");
    assert.deepEqual(r.verified_facts, ["Listed delivery estimate: 10 days"]);
  });

  it("answers price and budget", async () => {
    const { service } = await publishedNorthline();
    const r = await service.askMerchant(anon, ask("How much is it? My budget is $1,500."));
    assert.match(r.answer, /\$1,299\.00, which is within a \$1,500\.00 budget/);
  });

  it("confirms material and the 'solid' claim only from the description", async () => {
    const { service } = await publishedNorthline();
    const r = await service.askMerchant(anon, ask("Is it solid walnut?"));
    assert.match(r.answer, /listed material is walnut/);
    assert.match(r.answer, /calls it solid walnut/);
  });

  it("says no for a different material rather than agreeing", async () => {
    const { service } = await publishedNorthline();
    const r = await service.askMerchant(anon, ask("Is it made of oak?"));
    assert.match(r.answer, /^No\. The listed material is walnut, not oak\./);
  });

  it("explicitly acknowledges unknown attributes (color)", async () => {
    const { service } = await publishedNorthline();
    const r = await service.askMerchant(anon, ask("Is it available in black?"));
    assert.equal(r.answer, "I don't have verified information about whether this table is available in black.");
    assert.deepEqual(r.verified_facts, []);
    assert.deepEqual(r.missing_information, ["Availability in black"]);
  });

  it("does not invent dimensions, warranty or return policy", async () => {
    const { service } = await publishedNorthline();
    const r = await service.askMerchant(anon, ask("What are the dimensions, and what's the warranty and return policy?"));
    assert.deepEqual(r.missing_information, ["Dimensions", "Warranty terms", "Return policy"]);
    assert.doesNotMatch(r.answer, /\d+\s*(inches|cm|year)/);
  });

  it("answers several questions at once", async () => {
    const { service } = await publishedNorthline();
    const r = await service.askMerchant(anon, ask("Does it seat 6 and can it be delivered within 14 days?"));
    assert.deepEqual(r.verified_facts, ["Seats 6", "Listed delivery estimate: 10 days"]);
  });

  it("logs topics but not the raw question text", async () => {
    const { service, store } = await publishedNorthline();
    await service.askMerchant(anon, ask("Does this table seat six? My phone is 555-0100"));
    const ev = store.events.find((e) => e.event_type === "agent_question_asked");
    assert.ok(ev);
    assert.doesNotMatch(JSON.stringify(ev), /555-0100/);
  });
});

describe("askMerchant: isolation", () => {
  it("cannot reveal another merchant's data through the question", async () => {
    const { service } = await publishedNorthline();
    const r = await service.askMerchant(anon, ask("What does East Harbor charge for the Harbor Walnut Dining Table?"));
    assert.doesNotMatch(r.answer, /1,699|Harbor Walnut|East Harbor Living/);
    assert.match(r.answer, /\$1,299\.00/);
  });

  it("rejects substituting a product from an unrelated merchant", async () => {
    const { service } = await publishedNorthline();
    await assert.rejects(
      service.askMerchant(anon, { merchant_id: NORTHLINE, product_id: HARBOR_WALNUT_TABLE, question: "Price?" }),
      { code: "PRODUCT_MERCHANT_MISMATCH" },
    );
    await assert.rejects(
      service.askMerchant(anon, { merchant_id: HEARTH, product_id: NORTHLINE_TABLE, question: "Price?" }),
      { code: "PRODUCT_MERCHANT_MISMATCH" },
    );
  });

  it("an unpublished merchant's agent is not reachable by the public", async () => {
    const { service } = seededHarness();
    await assert.rejects(service.askMerchant(anon, ask("Does it seat six?")), { code: "MERCHANT_NOT_FOUND" });
    await assert.rejects(service.askMerchant(other, ask("Does it seat six?")), { code: "MERCHANT_NOT_FOUND" });
    // The owner can preview their own agent before publishing.
    const r = await service.askMerchant(owner, ask("Does it seat six?"));
    assert.match(r.answer, /seats 6/);
  });

  it("works for other published merchants with their own data", async () => {
    const { service } = seededHarness();
    const r = await service.askMerchant(anon, { merchant_id: HEARTH, product_id: HEARTH_OAK_TABLE, question: "Is it walnut?" });
    assert.match(r.answer, /^No\. The listed material is oak, not walnut\./);
    const r2 = await service.askMerchant(anon, { merchant_id: EAST_HARBOR, product_id: HARBOR_WALNUT_TABLE, question: "Can I buy it?" });
    assert.match(r2.answer, /checkout link configured/);
  });
});

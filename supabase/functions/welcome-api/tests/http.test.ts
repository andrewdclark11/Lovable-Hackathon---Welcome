// End-to-end through the HTTP handler: the exact envelope the frontend sees.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../lib/http.ts";
import { DEMO_OWNER, DEMO_QUERY, NORTHLINE, NORTHLINE_TABLE, seededHarness } from "./helpers.ts";

function setup() {
  const h = seededHarness();
  const handler = createHandler({
    service: h.service,
    // Test auth: "Bearer owner-token" is the demo owner; anything else is anonymous.
    resolveUser: async (req) => (req.headers.get("authorization") === "Bearer owner-token" ? DEMO_OWNER : null),
  });
  const call = async (body: unknown, token?: string, method = "POST") => {
    const res = await handler(new Request("http://localhost/welcome-api", {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    }));
    return { status: res.status, headers: res.headers, json: res.status === 204 ? null : await res.json() };
  };
  return { ...h, handler, call };
}

describe("HTTP contract", () => {
  it("full demo: search (none) -> publish -> search (Northline) -> ask -> checkout", async () => {
    const { call } = setup();

    const before = await call({ action: "searchProducts", payload: { query: DEMO_QUERY } });
    assert.equal(before.status, 200);
    assert.equal(before.json.ok, true);
    assert.equal(before.json.data.matches.length, 0);

    const pub = await call({ action: "setPublished", payload: { merchant_id: NORTHLINE, published: true } }, "owner-token");
    assert.equal(pub.status, 200);
    assert.equal(pub.json.data.merchant.published, true);

    const after = await call({ action: "searchProducts", payload: { query: DEMO_QUERY } });
    assert.equal(after.json.data.matches[0].product.id, NORTHLINE_TABLE);
    for (const key of ["merchant", "product", "match_reasons", "unknown_requirements"]) {
      assert.ok(key in after.json.data.matches[0], key);
    }

    const ask = await call({
      action: "askMerchant",
      payload: { merchant_id: NORTHLINE, product_id: NORTHLINE_TABLE, question: "Does this table seat six?" },
    });
    assert.equal(ask.json.data.answer, "Yes. The Solid Walnut Dining Table seats 6 people.");
    assert.equal(ask.json.data.simulated, true);

    const co = await call({ action: "createCheckoutIntent", payload: { merchant_id: NORTHLINE, product_id: NORTHLINE_TABLE } });
    assert.equal(co.status, 200);
    assert.equal(co.json.data.status, "demo_created");
    assert.equal(co.json.data.simulated, true);
    assert.equal(co.json.data.checkout_url, null);
  });

  it("error envelope + status codes", async () => {
    const { call } = setup();
    const cases: Array<[unknown, string | undefined, number, string]> = [
      ["{not json", undefined, 400, "INVALID_JSON"],
      [[1, 2], undefined, 400, "INVALID_REQUEST"],
      [{ action: "dropTables" }, undefined, 400, "UNKNOWN_ACTION"],
      [{ action: "searchProducts", payload: "x" }, undefined, 400, "INVALID_REQUEST"],
      [{ action: "searchProducts", payload: {} }, undefined, 400, "VALIDATION_ERROR"],
      [{ action: "setPublished", payload: { merchant_id: NORTHLINE, published: true } }, undefined, 401, "UNAUTHENTICATED"],
      [{ action: "getMerchant", payload: { merchant_id: NORTHLINE } }, undefined, 404, "MERCHANT_NOT_FOUND"],
    ];
    for (const [body, token, status, code] of cases) {
      const r = await call(body, token);
      assert.equal(r.status, status, `${JSON.stringify(body)} status`);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.error.code, code);
      assert.equal(typeof r.json.error.message, "string");
    }
  });

  it("CORS preflight and headers", async () => {
    const { call } = setup();
    const pre = await call(null, undefined, "OPTIONS");
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /authorization/);
    const get = await call(null, undefined, "GET");
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("access-control-allow-origin"), "*");
  });

  it("rejects oversized bodies", async () => {
    const { call } = setup();
    const r = await call({ action: "searchProducts", payload: { query: "x".repeat(70_000) } });
    assert.equal(r.status, 413);
  });

  it("hides internal errors", async () => {
    const h = seededHarness();
    h.store.listPublishedMerchants = async () => {
      throw new Error("connection string postgres://secret");
    };
    const handler = createHandler({ service: h.service, resolveUser: async () => null });
    const orig = console.error;
    console.error = () => {};
    try {
      const res = await handler(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "listMerchants" }) }));
      const body = await res.json();
      assert.equal(res.status, 500);
      assert.equal(body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(JSON.stringify(body), /secret/);
    } finally {
      console.error = orig;
    }
  });
});

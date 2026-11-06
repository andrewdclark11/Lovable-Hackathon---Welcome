import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConstraints, parseDeliveryWindow, parseMaxPrice, parseMinSeats } from "../lib/parser.ts";
import { DEMO_QUERY } from "./helpers.ts";

describe("parseConstraints", () => {
  it("parses the exact demo query", () => {
    assert.deepEqual(parseConstraints(DEMO_QUERY), {
      category: "Dining Tables",
      material: "walnut",
      max_price_cents: 150000,
      minimum_seats: 6,
      max_delivery_days: 14,
    });
  });

  it("parses the contract example query (no comma, 'seats six')", () => {
    assert.deepEqual(
      parseConstraints("Find a solid walnut dining table under $1500 that seats six and arrives within 14 days"),
      { category: "Dining Tables", material: "walnut", max_price_cents: 150000, minimum_seats: 6, max_delivery_days: 14 },
    );
  });

  it("parses the frontend's short example", () => {
    const c = parseConstraints("solid walnut dining table under $1500");
    assert.equal(c.category, "Dining Tables");
    assert.equal(c.material, "walnut");
    assert.equal(c.max_price_cents, 150000);
    assert.equal(c.minimum_seats, null);
    assert.equal(c.max_delivery_days, null);
  });

  it("returns nulls for unspecified constraints", () => {
    assert.deepEqual(parseConstraints("something nice"), {
      category: null, material: null, max_price_cents: null, minimum_seats: null, max_delivery_days: null,
    });
  });
});

describe("price parsing", () => {
  const cases: Array<[string, number | null]> = [
    ["under $1,500", 150000],
    ["below 1500 dollars", 150000],
    ["budget of $1.5k", 150000],
    ["$1200 or less", 120000],
    ["less than 2000", 200000],
    ["between $800 and $1,500", 150000],
    ["no more than $999.99", 99999],
    ["a $900 table", 90000],
    ["arrives within 14 days", null],
    ["for 6 people", null],
  ];
  for (const [q, want] of cases) it(`"${q}" -> ${want}`, () => assert.equal(parseMaxPrice(q), want));
});

describe("seat parsing", () => {
  const cases: Array<[string, number | null]> = [
    ["seats six", 6],
    ["seats 8", 8],
    ["seating for 6", 6],
    ["a six-person table", 6],
    ["6-seater", 6],
    ["for six people", 6],
    ["for eight", 8],
    ["fits four", 4],
    ["within 14 days", null],
    ["under $1500", null],
  ];
  for (const [q, want] of cases) it(`"${q}" -> ${want}`, () => assert.equal(parseMinSeats(q), want));
});

describe("delivery parsing", () => {
  const cases: Array<[string, number | null]> = [
    ["arrives within 14 days", 14],
    ["delivered in two weeks", 14],
    ["within a week", 7],
    ["by next week", 7],
    ["in 3 business days", 3],
    ["within a month", 30],
    ["10-day delivery", 10],
    ["seats six", null],
  ];
  for (const [q, want] of cases) it(`"${q}" -> ${want}`, () => assert.equal(parseDeliveryWindow(q)?.days ?? null, want));
});

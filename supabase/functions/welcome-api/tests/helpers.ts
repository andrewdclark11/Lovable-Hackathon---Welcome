import { readFileSync } from "node:fs";
import { InMemoryStore } from "../lib/store.ts";
import { WelcomeService } from "../lib/service.ts";
import type { AuthUser, Merchant, Product, RequestContext } from "../lib/types.ts";

// seed.json is generated from the real seed migration (see supabase/tests/db/run.sh).
const seed = JSON.parse(readFileSync(new URL("./fixtures/seed.json", import.meta.url), "utf8")) as {
  merchants: Merchant[];
  products: Product[];
};

export const NORTHLINE = "0a000000-0000-4000-8000-000000000001";
export const EAST_HARBOR = "0a000000-0000-4000-8000-000000000002";
export const HEARTH = "0a000000-0000-4000-8000-000000000003";
export const NORTHLINE_TABLE = "0b000000-0000-4000-8000-000000000101";
export const NORTHLINE_OAK_TABLE = "0b000000-0000-4000-8000-000000000103";
export const HARBOR_WALNUT_TABLE = "0b000000-0000-4000-8000-000000000201";
export const COMPACT_WALNUT_TABLE = "0b000000-0000-4000-8000-000000000202";
export const HEARTH_OAK_TABLE = "0b000000-0000-4000-8000-000000000301";
export const HEARTH_TRESTLE_TABLE = "0b000000-0000-4000-8000-000000000302";

export const DEMO_QUERY =
  "Find a solid walnut dining table under $1,500 that seats six people and arrives within 14 days.";

export const DEMO_OWNER: AuthUser = { id: "aaaaaaaa-0000-4000-8000-000000000001", email: "demo-merchant@example.com" };
export const OTHER_USER: AuthUser = { id: "bbbbbbbb-0000-4000-8000-000000000002", email: "someone-else@example.com" };

export const anon: RequestContext = { user: null };
export const owner: RequestContext = { user: DEMO_OWNER };
export const other: RequestContext = { user: OTHER_USER };

export interface Harness {
  store: InMemoryStore;
  service: WelcomeService;
  now: { t: number };
}

/** Fresh store loaded with the seed catalog; Northline owned by DEMO_OWNER (as after assign_welcome_demo_owner). */
export function seededHarness(): Harness {
  const now = { t: Date.parse("2026-11-06T15:00:00.000Z") };
  const clock = () => new Date(now.t);
  const store = new InMemoryStore(clock);
  for (const m of seed.merchants) {
    store.putMerchant({ ...m, owner_user_id: m.id === NORTHLINE ? DEMO_OWNER.id : null });
  }
  for (const p of seed.products) store.putProduct(p);
  return { store, service: new WelcomeService(store, clock), now };
}

export async function expectError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const c = (err as { code?: string }).code;
    if (c === code) return;
    throw new Error(`expected error ${code}, got ${c ?? String(err)}`);
  }
  throw new Error(`expected error ${code}, but the call succeeded`);
}

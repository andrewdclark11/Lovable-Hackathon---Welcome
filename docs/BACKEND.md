# Welcome backend: technical handoff

This is the backend for Welcome's agentic-commerce prototype: a merchant registry, publish controls, product discovery, a merchant agent and simulated checkout handoffs. It runs as one Supabase Edge Function, `welcome-api`, on top of Postgres.

> All merchants, products and transactions are **fictional demo data**. No payments are processed.

## Status at a glance

| Item | Status |
|---|---|
| Function name | `welcome-api` |
| Backend project | Must be the **same Supabase / Lovable Cloud project the Lovable app uses**. Not deployed yet: this repo had no Lovable app or Supabase config when the backend was written. |
| Migrations | `supabase/migrations/20261106150000_welcome_schema.sql`, `…150100_welcome_seed_demo.sql`. Verified on local Postgres 16 (schema, seed idempotency, RLS). |
| Tests | 88/88 TypeScript tests passing (`node --test`), plus the SQL/RLS suite passing. |
| Contract | Implements all 8 actions in the agreed contract. Some responses carry **extra fields**, listed below; no existing field was renamed or removed. |

## Files (backend-owned only)

```
supabase/
  migrations/
    20261106150000_welcome_schema.sql   tables, constraints, RLS policies
    20261106150100_welcome_seed_demo.sql 3 fictional merchants, 13 products, demo helper SQL functions
  functions/welcome-api/
    index.ts              Deno entrypoint: Supabase client, JWT -> user, Deno.serve
    lib/http.ts           envelope, CORS, size limit, error mapping (runtime-agnostic)
    lib/service.ts        the 8 actions + all authorization rules
    lib/parser.ts         natural-language -> constraints (deterministic, no LLM)
    lib/matcher.ts        eligibility, reasons, unknowns, deterministic ranking
    lib/agent.ts          grounded merchant-agent answers
    lib/validation.ts     dependency-free input validation
    lib/store.ts          persistence interface + in-memory store (tests)
    lib/supabase-store.ts Postgres store via supabase-js (parameterized, no raw SQL)
    tests/*.test.ts       discovery, agent, checkout, auth, HTTP contract, parser
  tests/db/run.sh         applies migrations to a throwaway Postgres and runs RLS assertions
  tests/smoke.sh          real requests against a deployed function
```

No frontend files (`src/**`), package files or styling were touched.

## Deploying to the Lovable project

1. **Merge** the `Backend` branch into the branch Lovable syncs (usually `main`). The only files involved are under `supabase/` and `docs/`, so there are no frontend conflicts. If Lovable already created `supabase/config.toml`, keep theirs.
2. **Apply the migrations** to the Lovable project's database. Choose one:
   - Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`.
   - Lovable Cloud / no CLI: paste the two migration files, in order, into the SQL editor. Both are safe to re-run.
3. **Deploy the function**: `supabase functions deploy welcome-api --no-verify-jwt`.
   - Why `--no-verify-jwt`: public discovery must work signed out, and the function does its own JWT verification for mutations. It also avoids gateway problems with the new `sb_publishable_…` keys. To make this permanent, add the following to the project's `supabase/config.toml`:
     ```toml
     [functions.welcome-api]
     verify_jwt = false
     ```
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically into deployed functions. **Never** put the service-role key in frontend code.
   - Optional secret: `WELCOME_ALLOWED_ORIGINS=https://your-app.lovable.app` locks CORS. The default is `*`.
4. **Create the demo merchant account** through the app's normal Supabase Auth sign-up, e.g. `demo-merchant@example.com`. Then run this in the SQL editor:
   ```sql
   select public.assign_welcome_demo_owner('demo-merchant@example.com');
   ```
   This makes that user the owner of Northline Furniture so they can publish it from the UI. East Harbor and Hearth & Home have no owner and are read-only.
5. **Verify with real requests**: `SUPABASE_URL=… SUPABASE_ANON_KEY=… supabase/tests/smoke.sh`. Add `OWNER_JWT=…` to also exercise publishing.
6. **Reset between demo rehearsals** (SQL editor): `select public.reset_welcome_demo();`. This unpublishes Northline and clears its demo checkout intents.

## Frontend integration

No new environment variables are needed beyond what the Lovable Supabase client already uses (`VITE_SUPABASE_URL` and the anon/publishable key).

```ts
const { data, error } = await supabase.functions.invoke("welcome-api", {
  body: { action: "searchProducts", payload: { query: "solid walnut dining table under $1500" } },
});
// 2xx: data = { ok: true, data: {...} }
// non-2xx: data is null and error is a FunctionsHttpError; read the envelope with:
//   const body = await error.context.json();   // { ok: false, error: { code, message } }
```

**Authentication.** `supabase.functions.invoke` automatically sends the signed-in user's access token. Signed out, it sends the anon key and the caller is treated as **public**. Mutations (`createMerchant`, `addProduct`, `setPublished`) require a signed-in user who owns the merchant.

## API contract

Every request is `POST` with `{ "action": string, "payload": object }`.

- Success: `{ "ok": true, "data": {...} }` with HTTP 200.
- Error: `{ "ok": false, "error": { "code", "message", "details"? } }`.

### Merchant object (all actions)

The merchant object has the database columns **except `owner_user_id`**, which is never exposed. It adds **`is_owner: boolean`**, which is true when the caller owns the merchant:

`{ id, name, description, category, website, published, created_at, updated_at, is_owner }`

### Product object

`{ id, merchant_id, name, description, category, material, seats, price_cents, delivery_days, inventory_status, checkout_url, created_at, updated_at }`

- `inventory_status` is one of `in_stock | low_stock | made_to_order | preorder | out_of_stock`.
- Money is always integer cents.

### Actions

| Action | Auth | Payload | `data` |
|---|---|---|---|
| `listMerchants` | public | `{}` | `{ merchants: (Merchant & { product_count })[] }`. Published merchants, plus the caller's own unpublished merchants. Sorted by name. |
| `getMerchant` | public | `{ merchant_id }` | `{ merchant, products }`. Returns 404 for an unpublished merchant unless the caller is its owner. |
| `createMerchant` | signed in | `{ name, description?, category?, website? }` | `{ merchant }`. Created **unpublished** and owned by the caller. |
| `addProduct` | owner | `{ merchant_id, name, category, price_cents, description?, material?, seats?, delivery_days?, inventory_status?, checkout_url? }` | `{ product, created }`. **Idempotent by name**: re-adding an existing name for that merchant updates it, and `created` is false. `material` is lower-cased. `checkout_url` must be https. |
| `setPublished` | owner | `{ merchant_id, published }` | `{ merchant }`. Takes effect on the next search. |
| `searchProducts` | public | `{ query }` (max 500 chars) | `{ query, constraints, matches, alternatives, total_matches }`. See below. |
| `askMerchant` | public* | `{ merchant_id, product_id, question }` | `{ merchant_id, product_id, answer, verified_facts, missing_information, simulated: true }` |
| `createCheckoutIntent` | public* | `{ merchant_id, product_id, idempotency_key? }` | `{ checkout_intent_id, status: "demo_created", checkout_url, merchant_id, product_id, amount_cents, payment_processed: false, simulated: true, deduplicated, created_at, message }` |

\* The merchant must be visible to the caller (published, or owned by the caller). Checkout additionally requires the merchant to be **published** and the product not out of stock.

### searchProducts

```json
{
  "constraints": { "category": "Dining Tables", "material": "walnut", "max_price_cents": 150000,
                   "minimum_seats": 6, "max_delivery_days": 14 },
  "matches": [{
    "merchant": { "...": "..." }, "product": { "...": "..." },
    "match_reasons": [
      "Category is Dining Tables, matching the requested Dining Tables.",
      "Material is walnut; the merchant describes it as solid walnut.",
      "Price is $1,299.00, within the $1,500.00 budget.",
      "Seats 6, meeting the requirement of at least 6.",
      "Listed delivery estimate is 10 days, within 14 days.",
      "In stock."
    ],
    "unknown_requirements": [],
    "verified": true
  }],
  "alternatives": [{
    "merchant": {}, "product": {}, "match_reasons": [],
    "failed_requirements": ["Price is $1,699.00, above the $1,500.00 budget."],
    "unknown_requirements": []
  }],
  "total_matches": 1
}
```

Constraints that aren't mentioned in the query are `null`.

**Discovery rules**

- Search only considers **published** merchants, for every caller, owners included.
- A product that violates any requirement (category, material, price, seats, delivery, or out of stock) is **never** in `matches`.
- A missing attribute is **not** assumed to pass. The product can appear in `matches` with `verified: false`, and the gap is listed in `unknown_requirements`. Verified matches always rank first.
- Ranking order: verified first, then fewer unknowns, then price ascending, then delivery ascending, then name, then id. There is no randomness.
- `alternatives` are near-misses. They are clearly marked non-matching: same category, at most two failed requirements, and at most five results. They give the "before publishing" state something honest to show. The UI can ignore them.
- If the query has no recognizable constraint, search falls back to keywords over name, description, category and material.

### Demo flow (real outputs from the test suite)

1. **Before**: `searchProducts` with the demo query returns `matches: []`. The alternatives are East Harbor's $1,699 table (over budget), its 4-seat table, Hearth & Home's oak table (wrong material) and its 35-day walnut table (too slow). Northline does not appear.
2. **Publish**: the demo owner calls `setPublished { merchant_id: "0a000000-0000-4000-8000-000000000001", published: true }`.
3. **After**: the same search returns Northline's **Solid Walnut Dining Table**, `0b000000-0000-4000-8000-000000000101`, with the match reasons above.
4. **Ask**: `"Does this table seat six?"` gives `"Yes. The Solid Walnut Dining Table seats 6 people."`. `"Can it arrive within two weeks?"` gives `"The listed delivery estimate is 10 days, which is within two weeks."`. `"Is it available in black?"` gives `"I don't have verified information about whether this table is available in black."`
5. **Checkout**: returns `status: "demo_created"`, `checkout_url: null`, `simulated: true`, `payment_processed: false`.

Seed IDs are fixed, so the UI can deep-link if needed:

| Merchant | ID | Published at seed |
|---|---|---|
| Northline Furniture | `0a000000-0000-4000-8000-000000000001` | no |
| East Harbor Living | `0a000000-0000-4000-8000-000000000002` | yes |
| Hearth & Home Studio | `0a000000-0000-4000-8000-000000000003` | yes |

### Error codes

| HTTP | code |
|---|---|
| 400 | `INVALID_JSON`, `INVALID_REQUEST`, `VALIDATION_ERROR` (`details.field` names the field), `UNKNOWN_ACTION`, `PRODUCT_MERCHANT_MISMATCH` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN` (merchant is visible but not yours) |
| 404 | `MERCHANT_NOT_FOUND` (also returned for unpublished merchants you don't own, so their existence isn't leaked), `PRODUCT_NOT_FOUND` |
| 405 / 413 | `METHOD_NOT_ALLOWED` / `PAYLOAD_TOO_LARGE` (64 KB) |
| 409 | `MERCHANT_NOT_PUBLISHED`, `PRODUCT_UNAVAILABLE` |
| 500 | `INTERNAL_ERROR` (generic message; details only go to the function logs) |

## Security model

- **Server-side authorization** lives in `lib/service.ts`. The function uses the service role internally, but every action checks ownership and visibility before reading or writing.
- **RLS** is enabled on all four tables as defense in depth for any direct client queries:
  - The public sees published merchants and their products.
  - Owners see and modify their own merchants and products.
  - `checkout_intents` can only be written by the function.
  - `activity_events` can be read by the owning merchant.
- All queries are parameterized through supabase-js. Inputs are type-, length- and range-checked, and control characters are stripped.
- URLs are validated: http(s) only, no embedded credentials, and checkout URLs must be https. The backend **never fetches** them.
- `activity_events` record topic labels and IDs only, never the shopper's raw question text.
- The demo helper SQL functions are revoked from `anon` and `authenticated`.

## Running the tests

```bash
node --test supabase/functions/welcome-api/tests/*.test.ts   # Node ≥ 22.18 (native TS); no install
supabase/tests/db/run.sh                                      # needs local Postgres server binaries
```

`tests/fixtures/seed.json` is generated from the real seed migration. To regenerate it after changing the seed, run `DUMP_SEED_JSON=… supabase/tests/db/run.sh`.

## Known limitations

- **Not yet deployed.** No Lovable project or Supabase credentials were available to the backend session. Follow the deployment steps above and run `smoke.sh`.
- The local DB tests use a minimal `auth` shim instead of real Supabase Auth. `supabase-store.ts` is type-checked but has only been exercised against PostgREST in production.
- The parser is deterministic and covers furniture categories, common materials, prices in USD, seat counts and delivery windows. Unusual phrasing may yield `null` constraints, which are shown in `constraints`, and the search never fabricates a match.
- Material matching is exact on the stored `material` field. "Solid" is only claimed when the merchant's own description says so.
- The merchant agent is template-based. Topics the schema doesn't store (color, dimensions, warranty, returns, shipping cost, assembly, care, weight) are always answered as unknown. An LLM layer could be added later on top of `verified_facts`.
- Checkout dedupe: without an `idempotency_key`, identical requests from the same caller within 30 s return the same intent. All signed-out callers share one "caller" for this purpose.
- Merchant policies such as returns and shipping, and product deletion, are not modeled yet.

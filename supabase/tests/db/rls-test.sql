-- RLS + seed assertions. Run after the shim and all migrations.
\set ON_ERROR_STOP on
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'demo-merchant@example.com'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'someone-else@example.com');

do $$ begin
  assert (select count(*) from public.merchants) = 3, 'expected 3 seeded merchants';
  assert (select count(*) from public.products) = 13, 'expected 13 seeded products';
  assert (select published from public.merchants where name = 'Northline Furniture') = false, 'Northline must start unpublished';
end $$;

-- Re-running the seed migration is idempotent.
\ir ../../migrations/20261106150100_welcome_seed_demo.sql
do $$ begin
  assert (select count(*) from public.products) = 13, 'seed re-run must not duplicate products';
end $$;

select public.assign_welcome_demo_owner('demo-merchant@example.com');

-- anon: only published merchants/products are visible.
set role anon;
do $$ begin
  assert (select count(*) from public.merchants) = 2, 'anon sees 2 published merchants';
  assert not exists (select 1 from public.merchants where name = 'Northline Furniture'), 'anon must not see Northline';
  assert not exists (select 1 from public.products where merchant_id = '0a000000-0000-4000-8000-000000000001'), 'anon must not see Northline products';
  assert (select count(*) from public.checkout_intents) = 0, 'anon cannot read checkout intents';
end $$;
reset role;

-- unrelated authenticated user: cannot see or publish Northline.
set role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', false);
do $$
declare n int;
begin
  assert not exists (select 1 from public.merchants where name = 'Northline Furniture'), 'other user must not see Northline';
  update public.merchants set published = true where id = '0a000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'other user must not publish Northline';
  update public.merchants set published = false where id = '0a000000-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  assert n = 0, 'other user must not unpublish East Harbor';
  begin
    insert into public.products (merchant_id, name, category, price_cents)
    values ('0a000000-0000-4000-8000-000000000002', 'Injected', 'Dining Tables', 1);
    assert false, 'other user must not add products to East Harbor';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- owner: sees and publishes Northline.
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', false);
do $$
declare n int;
begin
  assert exists (select 1 from public.merchants where name = 'Northline Furniture'), 'owner sees unpublished Northline';
  update public.merchants set published = true where id = '0a000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 1, 'owner can publish Northline';
end $$;
reset role;

set role anon;
do $$ begin
  assert exists (select 1 from public.products where name = 'Solid Walnut Dining Table'), 'after publish anon sees Northline table';
end $$;
reset role;

-- Constraint checks: no float/negative prices, valid inventory status.
do $$ begin
  begin
    insert into public.products (merchant_id, name, category, price_cents) values ('0a000000-0000-4000-8000-000000000001', 'Bad', 'X', -1);
    assert false, 'negative price must fail';
  exception when check_violation then null;
  end;
  begin
    insert into public.products (merchant_id, name, category, price_cents, inventory_status) values ('0a000000-0000-4000-8000-000000000001', 'Bad2', 'X', 1, 'teleporting');
    assert false, 'bad inventory status must fail';
  exception when check_violation then null;
  end;
end $$;

select public.reset_welcome_demo();
do $$ begin
  assert (select published from public.merchants where name = 'Northline Furniture') = false, 'reset unpublishes Northline';
end $$;

\echo 'ALL DB TESTS PASSED'

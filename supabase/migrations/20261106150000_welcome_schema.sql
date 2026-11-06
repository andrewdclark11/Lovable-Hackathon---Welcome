-- Welcome — core schema: merchant registry, products, checkout intents, activity events.
-- Money is stored as integer cents. All tables use row-level security.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function public.welcome_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- merchants
-- ---------------------------------------------------------------------------
create table if not exists public.merchants (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(btrim(name)) between 1 and 120),
  description    text check (description is null or char_length(description) <= 2000),
  category       text check (category is null or char_length(category) <= 80),
  website        text check (website is null or (char_length(website) <= 300 and website ~* '^https?://')),
  published      boolean not null default false,
  -- Nullable only for controlled, read-only demo seed merchants.
  owner_user_id  uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists merchants_published_idx on public.merchants (published);
create index if not exists merchants_owner_idx on public.merchants (owner_user_id);

drop trigger if exists merchants_set_updated_at on public.merchants;
create trigger merchants_set_updated_at
  before update on public.merchants
  for each row execute function public.welcome_set_updated_at();

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id                uuid primary key default gen_random_uuid(),
  merchant_id       uuid not null references public.merchants (id) on delete cascade,
  name              text not null check (char_length(btrim(name)) between 1 and 160),
  description       text check (description is null or char_length(description) <= 2000),
  category          text not null check (char_length(category) between 1 and 80),
  material          text check (material is null or char_length(material) <= 60),
  seats             integer check (seats is null or seats between 1 and 100),
  price_cents       integer not null check (price_cents between 0 and 100000000),
  delivery_days     integer check (delivery_days is null or delivery_days between 0 and 365),
  inventory_status  text not null default 'in_stock'
                    check (inventory_status in ('in_stock', 'low_stock', 'made_to_order', 'preorder', 'out_of_stock')),
  checkout_url      text check (checkout_url is null or (char_length(checkout_url) <= 500 and checkout_url ~* '^https://')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists products_merchant_idx on public.products (merchant_id);
create index if not exists products_category_idx on public.products (lower(category));
-- Prevents duplicate products (e.g. double-submitted forms, re-run seeds).
create unique index if not exists products_merchant_name_uidx on public.products (merchant_id, lower(name));

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.welcome_set_updated_at();

-- ---------------------------------------------------------------------------
-- checkout_intents — a simulated handoff record, NOT a payment or order.
-- ---------------------------------------------------------------------------
create table if not exists public.checkout_intents (
  id                 uuid primary key default gen_random_uuid(),
  merchant_id        uuid not null references public.merchants (id) on delete cascade,
  product_id         uuid not null references public.products (id) on delete cascade,
  status             text not null default 'demo_created'
                     check (status in ('demo_created', 'cancelled')),
  checkout_url       text,
  requester_user_id  uuid references auth.users (id) on delete set null,
  idempotency_key    text check (idempotency_key is null or char_length(idempotency_key) between 8 and 128),
  created_at         timestamptz not null default now()
);

create index if not exists checkout_intents_product_idx on public.checkout_intents (product_id, created_at desc);
create unique index if not exists checkout_intents_idempotency_uidx
  on public.checkout_intents (product_id, idempotency_key) where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- activity_events — lightweight audit trail. No PII, no raw shopper text.
-- ---------------------------------------------------------------------------
create table if not exists public.activity_events (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid references public.merchants (id) on delete cascade,
  product_id   uuid references public.products (id) on delete set null,
  event_type   text not null check (event_type in (
                 'merchant_created', 'merchant_published', 'merchant_unpublished',
                 'product_added', 'product_updated', 'product_discovered',
                 'agent_question_asked', 'checkout_handoff_created')),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists activity_events_merchant_idx on public.activity_events (merchant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security.
-- The welcome-api Edge Function enforces authorization server-side; these
-- policies are defense in depth for any direct client (anon/authenticated) access.
-- ---------------------------------------------------------------------------
alter table public.merchants        enable row level security;
alter table public.products         enable row level security;
alter table public.checkout_intents enable row level security;
alter table public.activity_events  enable row level security;

drop policy if exists merchants_select_visible on public.merchants;
create policy merchants_select_visible on public.merchants
  for select to anon, authenticated
  using (published or owner_user_id = auth.uid());

drop policy if exists merchants_insert_own on public.merchants;
create policy merchants_insert_own on public.merchants
  for insert to authenticated
  with check (owner_user_id = auth.uid());

drop policy if exists merchants_update_own on public.merchants;
create policy merchants_update_own on public.merchants
  for update to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

drop policy if exists products_select_visible on public.products;
create policy products_select_visible on public.products
  for select to anon, authenticated
  using (exists (
    select 1 from public.merchants m
    where m.id = products.merchant_id
      and (m.published or m.owner_user_id = auth.uid())
  ));

drop policy if exists products_insert_own on public.products;
create policy products_insert_own on public.products
  for insert to authenticated
  with check (exists (
    select 1 from public.merchants m
    where m.id = products.merchant_id and m.owner_user_id = auth.uid()
  ));

drop policy if exists products_update_own on public.products;
create policy products_update_own on public.products
  for update to authenticated
  using (exists (
    select 1 from public.merchants m
    where m.id = products.merchant_id and m.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.merchants m
    where m.id = products.merchant_id and m.owner_user_id = auth.uid()
  ));

-- checkout_intents: created only by the Edge Function (service role).
-- Signed-in shoppers may read their own intents.
drop policy if exists checkout_intents_select_own on public.checkout_intents;
create policy checkout_intents_select_own on public.checkout_intents
  for select to authenticated
  using (requester_user_id = auth.uid());

-- activity_events: merchant owners may read their own merchant's events.
drop policy if exists activity_events_select_owner on public.activity_events;
create policy activity_events_select_owner on public.activity_events
  for select to authenticated
  using (exists (
    select 1 from public.merchants m
    where m.id = activity_events.merchant_id and m.owner_user_id = auth.uid()
  ));

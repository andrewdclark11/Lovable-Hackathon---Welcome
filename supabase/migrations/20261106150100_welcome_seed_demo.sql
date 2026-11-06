-- Welcome — fictional demo merchants and catalogs.
-- All merchants, products and transactions here are fictional demonstration data.
-- Idempotent: fixed UUIDs + "on conflict do nothing" means re-running never
-- duplicates rows and never overwrites live state (e.g. Northline's publish flag).

-- Merchants -------------------------------------------------------------------
insert into public.merchants (id, name, description, category, website, published, owner_user_id) values
  ('0a000000-0000-4000-8000-000000000001',
   'Northline Furniture',
   'Independent furniture studio specializing in solid wood dining and living-room furniture.',
   'Furniture', 'https://northline.example', false, null),
  ('0a000000-0000-4000-8000-000000000002',
   'East Harbor Living',
   'Coastal-inspired home furnishings studio offering dining, seating and living-room pieces.',
   'Furniture', 'https://eastharbor.example', true, null),
  ('0a000000-0000-4000-8000-000000000003',
   'Hearth & Home Studio',
   'Small-batch farmhouse and craftsman furniture built from domestic hardwoods.',
   'Furniture', 'https://hearthandhome.example', true, null)
on conflict do nothing;

-- Northline Furniture (starts UNPUBLISHED) ------------------------------------
insert into public.products (id, merchant_id, name, description, category, material, seats, price_cents, delivery_days, inventory_status, checkout_url) values
  ('0b000000-0000-4000-8000-000000000101', '0a000000-0000-4000-8000-000000000001',
   'Solid Walnut Dining Table',
   'Solid American walnut dining table with a hand-rubbed oil finish. Seats six.',
   'Dining Tables', 'walnut', 6, 129900, 10, 'in_stock', null),
  ('0b000000-0000-4000-8000-000000000102', '0a000000-0000-4000-8000-000000000001',
   'Walnut Dining Bench',
   'Solid walnut bench sized to pair with the Solid Walnut Dining Table. Seats three.',
   'Benches', 'walnut', 3, 54900, 10, 'in_stock', null),
  ('0b000000-0000-4000-8000-000000000103', '0a000000-0000-4000-8000-000000000001',
   'Oak Extending Dining Table',
   'White oak dining table with two hidden leaves, extending to seat eight.',
   'Dining Tables', 'oak', 8, 189900, 21, 'made_to_order', null),
  ('0b000000-0000-4000-8000-000000000104', '0a000000-0000-4000-8000-000000000001',
   'Solid Walnut Coffee Table',
   'Low-profile solid walnut coffee table with rounded corners.',
   'Coffee Tables', 'walnut', null, 69900, 10, 'low_stock', null),
  ('0b000000-0000-4000-8000-000000000105', '0a000000-0000-4000-8000-000000000001',
   'Walnut Media Console',
   'Solid walnut media console with cane-front doors and cable management.',
   'Media Consoles', 'walnut', null, 99900, 12, 'in_stock', null)
on conflict do nothing;

-- East Harbor Living (published) — plausible, but misses the demo query -------
insert into public.products (id, merchant_id, name, description, category, material, seats, price_cents, delivery_days, inventory_status, checkout_url) values
  ('0b000000-0000-4000-8000-000000000201', '0a000000-0000-4000-8000-000000000002',
   'Harbor Walnut Dining Table',
   'Walnut dining table with a live-edge top and blackened steel base. Seats six.',
   'Dining Tables', 'walnut', 6, 169900, 7, 'in_stock', 'https://eastharbor.example/checkout/harbor-walnut-dining-table'),
  ('0b000000-0000-4000-8000-000000000202', '0a000000-0000-4000-8000-000000000002',
   'Compact Walnut Dining Table',
   'Apartment-sized walnut dining table. Seats four.',
   'Dining Tables', 'walnut', 4, 89900, 5, 'in_stock', 'https://eastharbor.example/checkout/compact-walnut-dining-table'),
  ('0b000000-0000-4000-8000-000000000203', '0a000000-0000-4000-8000-000000000002',
   'Coastal Linen Sofa',
   'Three-seat sofa with slipcovered linen upholstery and feather-wrapped cushions.',
   'Sofas', 'linen', 3, 149900, 21, 'in_stock', 'https://eastharbor.example/checkout/coastal-linen-sofa'),
  ('0b000000-0000-4000-8000-000000000204', '0a000000-0000-4000-8000-000000000002',
   'Walnut Dining Chair',
   'Sculpted walnut dining chair with a woven rush seat.',
   'Dining Chairs', 'walnut', 1, 24900, 7, 'in_stock', 'https://eastharbor.example/checkout/walnut-dining-chair')
on conflict do nothing;

-- Hearth & Home Studio (published) — differs on material / delivery ------------
insert into public.products (id, merchant_id, name, description, category, material, seats, price_cents, delivery_days, inventory_status, checkout_url) values
  ('0b000000-0000-4000-8000-000000000301', '0a000000-0000-4000-8000-000000000003',
   'Farmhouse Oak Dining Table',
   'Solid red oak farmhouse dining table with a breadboard top. Seats six.',
   'Dining Tables', 'oak', 6, 119900, 9, 'in_stock', null),
  ('0b000000-0000-4000-8000-000000000302', '0a000000-0000-4000-8000-000000000003',
   'Walnut Trestle Dining Table',
   'Hand-built walnut trestle dining table, made to order in our workshop. Seats six.',
   'Dining Tables', 'walnut', 6, 139900, 35, 'made_to_order', null),
  ('0b000000-0000-4000-8000-000000000303', '0a000000-0000-4000-8000-000000000003',
   'Maple Bookshelf',
   'Five-shelf solid maple bookshelf with adjustable shelves.',
   'Bookshelves', 'maple', null, 64900, 6, 'in_stock', null),
  ('0b000000-0000-4000-8000-000000000304', '0a000000-0000-4000-8000-000000000003',
   'Oak Coffee Table',
   'Craftsman-style oak coffee table with a lower shelf.',
   'Coffee Tables', 'oak', null, 49900, 8, 'in_stock', null)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Demo helpers. Not callable by anon/authenticated clients — run them from the
-- Supabase SQL editor (or with the service role).
-- ---------------------------------------------------------------------------

-- Assign Northline Furniture to the demo merchant account so it can be
-- published from the UI by that signed-in user.
--   select public.assign_welcome_demo_owner('demo-merchant@example.com');
create or replace function public.assign_welcome_demo_owner(p_email text)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid;
begin
  select id into v_user_id from auth.users where lower(email) = lower(p_email) limit 1;
  if v_user_id is null then
    raise exception 'No auth user found with email %', p_email;
  end if;
  update public.merchants
     set owner_user_id = v_user_id
   where id = '0a000000-0000-4000-8000-000000000001';
  return v_user_id;
end;
$$;

-- Reset the before/after demo: Northline back to unpublished, demo intents cleared.
--   select public.reset_welcome_demo();
create or replace function public.reset_welcome_demo()
returns void
language sql
security definer
set search_path = public
as $$
  update public.merchants set published = false where id = '0a000000-0000-4000-8000-000000000001';
  delete from public.checkout_intents where merchant_id = '0a000000-0000-4000-8000-000000000001';
$$;

revoke all on function public.assign_welcome_demo_owner(text) from public, anon, authenticated;
revoke all on function public.reset_welcome_demo() from public, anon, authenticated;

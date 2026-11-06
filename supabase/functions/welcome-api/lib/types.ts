// Domain types for the Welcome backend. These mirror the database model.

export const INVENTORY_STATUSES = [
  "in_stock",
  "low_stock",
  "made_to_order",
  "preorder",
  "out_of_stock",
] as const;
export type InventoryStatus = typeof INVENTORY_STATUSES[number];

export interface Merchant {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  website: string | null;
  published: boolean;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Merchant as returned by the API: owner_user_id is replaced by is_owner. */
export interface PublicMerchant extends Omit<Merchant, "owner_user_id"> {
  is_owner: boolean;
}

export interface Product {
  id: string;
  merchant_id: string;
  name: string;
  description: string | null;
  category: string;
  material: string | null;
  seats: number | null;
  price_cents: number;
  delivery_days: number | null;
  inventory_status: InventoryStatus;
  checkout_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface CheckoutIntent {
  id: string;
  merchant_id: string;
  product_id: string;
  status: "demo_created" | "cancelled";
  checkout_url: string | null;
  requester_user_id: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export type ActivityEventType =
  | "merchant_created"
  | "merchant_published"
  | "merchant_unpublished"
  | "product_added"
  | "product_updated"
  | "product_discovered"
  | "agent_question_asked"
  | "checkout_handoff_created";

export interface ActivityEvent {
  merchant_id: string | null;
  product_id: string | null;
  event_type: ActivityEventType;
  metadata: Record<string, unknown>;
}

/** The authenticated caller, or null for a public/anonymous requester. */
export interface AuthUser {
  id: string;
  email: string | null;
}

export interface RequestContext {
  user: AuthUser | null;
}

export interface SearchConstraints {
  category: string | null;
  material: string | null;
  max_price_cents: number | null;
  minimum_seats: number | null;
  max_delivery_days: number | null;
}

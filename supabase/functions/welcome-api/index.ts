// Welcome API — Supabase Edge Function entrypoint (Deno).
//
// POST { action, payload } -> { ok: true, data } | { ok: false, error: { code, message } }
// See docs/BACKEND.md for the full contract.
//
// Environment (provided automatically by Supabase for deployed functions):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   WELCOME_ALLOWED_ORIGINS  comma-separated CORS origins (default "*")

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { createHandler } from "./lib/http.ts";
import { WelcomeService } from "./lib/service.ts";
import { SupabaseStore } from "./lib/supabase-store.ts";
import type { AuthUser } from "./lib/types.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("welcome-api requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
}

// Server-side only. This key never leaves the Edge Function.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Identify the caller from the Authorization bearer token. The anon/publishable
 * key (sent by supabase.functions.invoke when signed out) is not a user token,
 * so it resolves to an anonymous requester.
 */
async function resolveUser(req: Request): Promise<AuthUser | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token || token.split(".").length !== 3) return null;
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
  }
}

const handler = createHandler({
  service: new WelcomeService(new SupabaseStore(admin)),
  resolveUser,
  allowedOrigins: Deno.env.get("WELCOME_ALLOWED_ORIGINS") ?? "*",
});

Deno.serve(handler);

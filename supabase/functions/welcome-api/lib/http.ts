// Runtime-agnostic HTTP handler: Request -> Response. Used by the Deno entrypoint
// and directly by tests. Handles CORS, size limits, JSON parsing, the
// { action, payload } envelope, auth resolution and error mapping.

import { isWelcomeError, WelcomeError } from "./errors.ts";
import { isAction, WelcomeService } from "./service.ts";
import type { AuthUser } from "./types.ts";

export const MAX_BODY_BYTES = 64 * 1024;

export interface HandlerDeps {
  service: WelcomeService;
  /** Resolve the caller from the request (e.g. verify the Supabase JWT). Null = anonymous. */
  resolveUser: (req: Request) => Promise<AuthUser | null>;
  /** Comma-separated allowed origins, or "*" (default). */
  allowedOrigins?: string;
}

export function corsHeaders(req: Request, allowedOrigins = "*"): Record<string, string> {
  let origin = "*";
  if (allowedOrigins.trim() !== "*") {
    const list = allowedOrigins.split(",").map((s) => s.trim()).filter(Boolean);
    const reqOrigin = req.headers.get("origin") ?? "";
    origin = list.includes(reqOrigin) ? reqOrigin : list[0] ?? "null";
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorBody(err: WelcomeError) {
  return {
    ok: false,
    error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
  };
}

export function createHandler(deps: HandlerDeps) {
  return async function handle(req: Request): Promise<Response> {
    const cors = corsHeaders(req, deps.allowedOrigins);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (req.method !== "POST") {
        throw new WelcomeError("METHOD_NOT_ALLOWED", "Use POST with a JSON body { action, payload }.");
      }
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY_BYTES) throw new WelcomeError("PAYLOAD_TOO_LARGE", "Request body is too large.");
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) throw new WelcomeError("PAYLOAD_TOO_LARGE", "Request body is too large.");

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new WelcomeError("INVALID_JSON", "Request body must be valid JSON.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new WelcomeError("INVALID_REQUEST", "Request body must be an object { action, payload }.");
      }
      const { action, payload } = body as { action?: unknown; payload?: unknown };
      if (!isAction(action)) {
        throw new WelcomeError("UNKNOWN_ACTION", `Unknown action: ${String(action).slice(0, 60)}`);
      }

      const user = await deps.resolveUser(req);
      const ctx = { user };
      const s = deps.service;
      let data: unknown;
      switch (action) {
        case "listMerchants": data = await s.listMerchants(ctx, payload); break;
        case "getMerchant": data = await s.getMerchant(ctx, payload); break;
        case "createMerchant": data = await s.createMerchant(ctx, payload); break;
        case "addProduct": data = await s.addProduct(ctx, payload); break;
        case "setPublished": data = await s.setPublished(ctx, payload); break;
        case "searchProducts": data = await s.searchProducts(ctx, payload); break;
        case "askMerchant": data = await s.askMerchant(ctx, payload); break;
        case "createCheckoutIntent": data = await s.createCheckoutIntent(ctx, payload); break;
      }
      return json({ ok: true, data }, 200, cors);
    } catch (err) {
      if (isWelcomeError(err)) return json(errorBody(err), err.status, cors);
      console.error("welcome-api internal error", err instanceof Error ? err.stack ?? err.message : err);
      return json(errorBody(new WelcomeError("INTERNAL_ERROR", "Something went wrong. Please try again.")), 500, cors);
    }
  };
}

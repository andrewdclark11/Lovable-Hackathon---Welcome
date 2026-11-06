// Dependency-free input validation (portable across Deno and Node tests).
// Each validator returns a typed value or throws VALIDATION_ERROR naming the field.

import { WelcomeError } from "./errors.ts";
import { INVENTORY_STATUSES, type InventoryStatus } from "./types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Payload = Record<string, unknown>;

function fail(field: string, message: string): never {
  throw new WelcomeError("VALIDATION_ERROR", `${field}: ${message}`, { field });
}

export function asPayload(value: unknown): Payload {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WelcomeError("INVALID_REQUEST", "payload must be a JSON object");
  }
  return value as Payload;
}

/** Strip control characters (except newline/tab) and trim. */
function clean(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

export function requiredString(p: Payload, field: string, max: number): string {
  const v = p[field];
  if (typeof v !== "string") fail(field, "is required and must be a string");
  const s = clean(v);
  if (s.length === 0) fail(field, "must not be empty");
  if (s.length > max) fail(field, `must be at most ${max} characters`);
  return s;
}

export function optionalString(p: Payload, field: string, max: number): string | null {
  const v = p[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") fail(field, "must be a string or null");
  const s = clean(v);
  if (s.length === 0) return null;
  if (s.length > max) fail(field, `must be at most ${max} characters`);
  return s;
}

export function requiredUuid(p: Payload, field: string): string {
  const v = p[field];
  if (typeof v !== "string" || !UUID_RE.test(v)) fail(field, "must be a valid UUID");
  return v.toLowerCase();
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function requiredBoolean(p: Payload, field: string): boolean {
  const v = p[field];
  if (typeof v !== "boolean") fail(field, "is required and must be a boolean");
  return v;
}

export function requiredInt(p: Payload, field: string, min: number, max: number): number {
  const v = p[field];
  if (typeof v !== "number" || !Number.isInteger(v)) fail(field, "is required and must be an integer");
  if (v < min || v > max) fail(field, `must be between ${min} and ${max}`);
  return v;
}

export function optionalInt(p: Payload, field: string, min: number, max: number): number | null {
  const v = p[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) fail(field, "must be an integer or null");
  if (v < min || v > max) fail(field, `must be between ${min} and ${max}`);
  return v;
}

/**
 * Validate a URL string. The backend never fetches these URLs; they are only
 * stored and echoed back. Credentials in URLs and non-http(s) schemes are rejected.
 */
export function optionalUrl(p: Payload, field: string, opts: { httpsOnly: boolean }): string | null {
  const s = optionalString(p, field, opts.httpsOnly ? 500 : 300);
  if (s === null) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    fail(field, "must be a valid URL");
  }
  const allowed = opts.httpsOnly ? ["https:"] : ["https:", "http:"];
  if (!allowed.includes(url.protocol)) fail(field, `must use ${opts.httpsOnly ? "https" : "http or https"}`);
  if (url.username || url.password) fail(field, "must not contain credentials");
  return url.toString();
}

export function inventoryStatus(p: Payload, field: string): InventoryStatus {
  const v = p[field];
  if (v === undefined || v === null) return "in_stock";
  if (typeof v !== "string" || !(INVENTORY_STATUSES as readonly string[]).includes(v)) {
    fail(field, `must be one of ${INVENTORY_STATUSES.join(", ")}`);
  }
  return v as InventoryStatus;
}

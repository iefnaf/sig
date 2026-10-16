// Feishu app-registration device flow (RFC 8628): the QR-code bot creation behind issue #24
// (feishu-channel.md §1/§8.1, steward.md §9.0). Wire format mirrors the official SDK's
// `scene/registration` (commit e34a66f0): a bare `begin` POST returns `device_code` and
// `verification_uri_complete`; every per-deployment prefill (name/desc/createOnly/clientID and
// the gzip+base64url `addons` payload) rides the QR URL as query params, never the POST.
// `poll` answers pending states with HTTP 4xx + a JSON `error` body, so status is ignored and
// only the parsed body decides. A `lark` tenant brand switches the accounts domain mid-flow.
import type { Brand } from "./types.ts";

export const FEISHU_ACCOUNTS_BASE = "https://accounts.feishu.cn";
export const LARK_ACCOUNTS_BASE = "https://accounts.larksuite.com";
const REGISTRATION_PATH = "/oauth/v1/app/registration";

// Mirrors the SDK's request timeout for the accounts endpoint (shorter than the general
// FEISHU_API budget: QR onboarding should fail fast and let the page offer a retry).
export const REGISTRATION_TIMEOUT_MS = 10_000;

export const DEFAULT_POLL_INTERVAL_S = 5;
export const DEFAULT_EXPIRES_IN_S = 600;
// RFC 8628 `slow_down`: back off by 5s on top of the current interval (SDK parity).
export const SLOW_DOWN_EXTRA_S = 5;

/** The one extra scope the webhook switch needs (research §8.2: granted by the second scan). */
export const APP_CONFIG_PATCH_SCOPE = "application:application:patch";

export interface AppPreset {
  /** App name prefill; the deployment-distinguishing part must lead (names get truncated). */
  name?: string;
  /** App description prefill. */
  desc?: string;
}

export interface AppAddons {
  preset?: boolean;
  scopes?: { tenant?: string[]; user?: string[] };
  events?: { items?: { tenant?: string[]; user?: string[] } };
  callbacks?: { items?: string[] };
}

export interface BeginResult {
  deviceCode: string;
  /** The decorated, scan-ready URL (prefills applied) — what the QR code encodes. */
  qrUrl: string;
  userCode: string;
  intervalS: number;
  expiresAt: number;
}

export type PollOutcome = (
  | { status: "pending"; openId?: string }
  | { status: "slow_down" }
  | { status: "success"; appId: string; appSecret?: string; openId?: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "failed"; message: string }
) & { brand?: Brand };

export interface BeginOptions {
  fetcher: typeof fetch;
  brand?: Brand;
  /** Prefills applied to the QR URL (create flow). */
  preset?: AppPreset;
  /** Incremental config for the confirm page (scope-top-up flow). */
  addons?: AppAddons;
  /** Hide the "select existing app" entry — the create flow must yield a fresh app. */
  createOnly?: boolean;
  /** Target an existing app for the update flow; rides the URL as `clientID`. */
  clientId?: string;
  now?: () => number;
}

export function accountsBase(brand: Brand): string {
  return brand === "lark" ? LARK_ACCOUNTS_BASE : FEISHU_ACCOUNTS_BASE;
}

/** The developer-console base for app links shown on the setup page. */
export function consoleBase(brand: Brand): string {
  return brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

async function postRegistration(fetcher: typeof fetch, baseUrl: string, params: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetcher(`${baseUrl}${REGISTRATION_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`registration request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Pending/error states arrive as HTTP 4xx with a JSON body (SDK parity): parse, don't throw.
  return await res.json().catch(() => {
    throw new Error(`registration returned http ${res.status}`);
  });
}

export async function beginDeviceFlow(opts: BeginOptions): Promise<BeginResult> {
  const now = opts.now ?? Date.now;
  const raw = (await postRegistration(opts.fetcher, accountsBase(opts.brand ?? "feishu"), {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  })) as {
    device_code?: unknown;
    verification_uri_complete?: unknown;
    user_code?: unknown;
    interval?: unknown;
    expires_in?: unknown;
  };
  if (typeof raw?.device_code !== "string" || typeof raw?.verification_uri_complete !== "string") {
    throw new Error("registration begin response malformed");
  }
  const intervalS = typeof raw.interval === "number" && raw.interval > 0 ? raw.interval : DEFAULT_POLL_INTERVAL_S;
  const expiresAt = now() + (typeof raw.expires_in === "number" && raw.expires_in > 0 ? raw.expires_in : DEFAULT_EXPIRES_IN_S) * 1000;

  const qrUrl = new URL(raw.verification_uri_complete);
  if (opts.preset?.name !== undefined) qrUrl.searchParams.set("name", opts.preset.name);
  if (opts.preset?.desc !== undefined) qrUrl.searchParams.set("desc", opts.preset.desc);
  if (opts.addons) qrUrl.searchParams.set("addons", await encodeAddons(opts.addons));
  // The landing page honors only the literal "true" (SDK parity); omit otherwise.
  if (opts.createOnly === true) qrUrl.searchParams.set("createOnly", "true");
  if (opts.clientId) qrUrl.searchParams.set("clientID", opts.clientId);

  return {
    deviceCode: raw.device_code,
    qrUrl: qrUrl.toString(),
    userCode: typeof raw.user_code === "string" ? raw.user_code : "",
    intervalS,
    expiresAt,
  };
}

export async function pollDeviceFlow(opts: { fetcher: typeof fetch; deviceCode: string; brand: Brand }): Promise<PollOutcome> {
  const raw = (await postRegistration(opts.fetcher, accountsBase(opts.brand), {
    action: "poll",
    device_code: opts.deviceCode,
  })) as {
    client_id?: unknown;
    client_secret?: unknown;
    user_info?: { open_id?: unknown; tenant_brand?: unknown };
    error?: unknown;
    error_description?: unknown;
  };
  const brand: Brand | undefined =
    raw.user_info?.tenant_brand === "lark" ? "lark" : raw.user_info?.tenant_brand === "feishu" ? "feishu" : undefined;
  const openId = typeof raw.user_info?.open_id === "string" ? raw.user_info.open_id : undefined;

  if (typeof raw.client_id === "string" && typeof raw.client_secret === "string") {
    return { status: "success", appId: raw.client_id, appSecret: raw.client_secret, openId, brand: brand ?? "feishu" };
  }
  if (typeof raw.client_id === "string") {
    // The update flow may confirm without rotating the secret; treat id-only as success too.
    return { status: "success", appId: raw.client_id, openId, brand: brand ?? "feishu" };
  }
  switch (raw.error) {
    case "authorization_pending":
    case undefined:
    case null:
      return { status: "pending", openId, brand };
    case "slow_down":
      return { status: "slow_down", brand };
    case "access_denied":
      return { status: "denied", brand };
    case "expired_token":
      return { status: "expired", brand };
    default:
      return {
        status: "failed",
        message: `${String(raw.error)}: ${typeof raw.error_description === "string" ? raw.error_description : "unknown"}`,
        brand,
      };
  }
}

// ---- addons encoding (SDK `encodeAddons` parity) ------------------------------------------------
// Pipeline fixed by the platform: JSON.stringify → gzip → base64 → URL-safe → strip '='.
// In a Worker, gzip goes through CompressionStream instead of node:zlib.

const ADDONS_ALLOWED_KEYS = ["preset", "scopes", "events", "callbacks"] as const;

function validateStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of strings`);
  value.forEach((item, idx) => {
    if (typeof item !== "string" || item === "") throw new Error(`${path}[${idx}] must be a non-empty string`);
  });
  return value as string[];
}

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
}

function assertAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not allowed; allowed keys: ${allowed.join(", ")}`);
  }
}

/**
 * Validates and encodes `addons` for the QR URL. Mirrors the SDK's whitelist validation: the
 * confirm page silently discards shape mismatches, so unknown keys must fail loudly here.
 */
export async function encodeAddons(addons: AppAddons): Promise<string> {
  assertPlainObject(addons, "addons");
  assertAllowedKeys(addons, ADDONS_ALLOWED_KEYS, "addons");

  let itemCount = 0;
  const pick = (value: unknown, path: string): string[] | undefined => {
    const items = validateStringArray(value, path);
    itemCount += items?.length ?? 0;
    return items;
  };

  const normalized: AppAddons = {};
  if (addons.preset !== undefined) {
    if (typeof addons.preset !== "boolean") throw new Error("addons.preset must be a boolean");
    normalized.preset = addons.preset;
  }
  if (addons.scopes !== undefined) {
    assertPlainObject(addons.scopes, "addons.scopes");
    assertAllowedKeys(addons.scopes, ["tenant", "user"], "addons.scopes");
    normalized.scopes = {
      tenant: pick(addons.scopes.tenant, "addons.scopes.tenant"),
      user: pick(addons.scopes.user, "addons.scopes.user"),
    };
  }
  if (addons.events !== undefined) {
    assertPlainObject(addons.events, "addons.events");
    assertAllowedKeys(addons.events, ["items"], "addons.events");
    if (addons.events.items !== undefined) {
      assertPlainObject(addons.events.items, "addons.events.items");
      assertAllowedKeys(addons.events.items, ["tenant", "user"], "addons.events.items");
      normalized.events = {
        items: {
          tenant: pick(addons.events.items.tenant, "addons.events.items.tenant"),
          user: pick(addons.events.items.user, "addons.events.items.user"),
        },
      };
    }
  }
  if (addons.callbacks !== undefined) {
    assertPlainObject(addons.callbacks, "addons.callbacks");
    assertAllowedKeys(addons.callbacks, ["items"], "addons.callbacks");
    normalized.callbacks = { items: pick(addons.callbacks.items, "addons.callbacks.items") };
  }
  if (itemCount === 0 && addons.preset !== false) {
    throw new Error("addons must contain at least one scope, event or callback");
  }

  const gzipped = await gzip(new TextEncoder().encode(JSON.stringify(normalized)));
  return toBase64(gzipped).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

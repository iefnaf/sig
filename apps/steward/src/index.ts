import { getAgentByName, routeAgentRequest } from "agents";
import { parseToken } from "@alexlikevibe/protocol";
import { bearer, resolveServerKeys } from "./auth.ts";
import { AVATAR_PATH, LOGO_PATH } from "./brand.ts";
import { ownerAuthorized } from "./deployment-auth.ts";
import { LOGIN_SCRIPT_PATH, loginPage } from "./login-page.ts";
import { readJsonObject, Steward } from "./steward.ts";
import { parseSessionCookie } from "./web.ts";

export { Steward };

const AUTH_BODY_LIMIT = 8 * 1024;
const AUTH_ROUTES = new Set(["/auth/password", "/webauthn/login/options", "/webauthn/login/verify"]);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function rateLimited(retryAfterSec = 60): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(retryAfterSec), "cache-control": "no-store" },
  });
}

function requestTooLarge(request: Request): boolean {
  const length = Number(request.headers.get("content-length"));
  return Number.isFinite(length) && length > AUTH_BODY_LIMIT;
}

function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("origin") === url.origin;
}

function sessionCookie(request: Request): string | null {
  return (request.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .find((part) => part.startsWith("sig_session="))
    ?.slice("sig_session=".length) ?? null;
}

function wellFormedSessionCookie(value: string | null): boolean {
  return value !== null && /^ws1\.[0-9a-f]{64}\.[0-9a-f]{64}$/.test(value);
}

async function workspaceShell(env: Env, url: URL): Promise<Response> {
  const page = await env.ASSETS.fetch(new Request(new URL("/workspace", url.origin)));
  if (!page.ok) return new Response("workspace unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  const socket = `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
  return new Response(page.body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        `connect-src 'self' ${socket}`,
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function serveAppAsset(env: Env, request: Request, url: URL): Promise<Response> {
  const name = url.pathname.slice("/app/assets/".length);
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) return new Response("not found", { status: 404 });
  const asset = await env.ASSETS.fetch(new Request(new URL(`/${name}`, url.origin), request));
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "private, max-age=0, must-revalidate");
  headers.set("x-content-type-options", "nosniff");
  return new Response(asset.body, { status: asset.status, headers });
}

async function edgeAuthBudget(env: Env, scope: string, ip: string): Promise<boolean> {
  if (!env.LOGIN_RATE_LIMITER) return true;
  try {
    return (await env.LOGIN_RATE_LIMITER.limit({ key: `${scope}:${ip}` })).success;
  } catch {
    return false;
  }
}

async function routeOwnerSocket(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("not found", { status: 404 });
  }
  const role = url.searchParams.get("role");
  const rawCookie = sessionCookie(request);
  const token = bearer(request);
  if (role === "web" && !wellFormedSessionCookie(rawCookie)) return new Response("unauthorized", { status: 401 });
  if (role !== "web" && !token) return new Response("unauthorized", { status: 401 });

  // Explicit-key deployments keep the stateless pre-check. A generated-key deployment cannot
  // expose its key here, so the Durable Object verifies the credential in onConnect.
  if (env.SERVER_KEY) {
    if (role === "web") {
      const keys = [env.SERVER_KEY, env.SERVER_KEY_PREVIOUS].filter((key): key is string => !!key);
      if (!(await parseSessionCookie(keys, rawCookie))) return new Response("unauthorized", { status: 401 });
    } else if (!(await parseToken(await resolveServerKeys(env), token))) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  return (await routeAgentRequest(new Request(url, request), env)) ?? new Response("not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if ((request.method === "GET" || request.method === "HEAD") &&
        (url.pathname === LOGO_PATH || url.pathname === AVATAR_PATH || url.pathname === LOGIN_SCRIPT_PATH)) {
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set("cache-control", "public, max-age=0, must-revalidate");
      headers.set("x-content-type-options", "nosniff");
      return new Response(asset.body, { status: asset.status, headers });
    }

    if (url.pathname === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("not found", { status: 404 });
      // A recent-auth challenge must show the form even when an older valid session cookie is
      // present; otherwise /?reauth=1 would bounce straight back into the workspace forever.
      if (url.searchParams.get("reauth") !== "1" && wellFormedSessionCookie(sessionCookie(request))) {
        return new Response(null, { status: 303, headers: { location: "/app", "cache-control": "no-store" } });
      }
      return loginPage();
    }

    if (AUTH_ROUTES.has(url.pathname)) {
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      if (!sameOrigin(request, url)) return json({ error: "forbidden" }, 403);
      if (requestTooLarge(request)) return json({ error: "too_large" }, 413);
      if (url.pathname === "/auth/password" || url.pathname === "/webauthn/login/verify") {
        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "json_required" }, 415);
      }
      const scope = url.pathname === "/auth/password"
        ? "password"
        : url.pathname === "/webauthn/login/options" ? "passkey-options" : "passkey-verify";
      if (!(await edgeAuthBudget(env, scope, request.headers.get("CF-Connecting-IP") ?? "unknown"))) return rateLimited();
      const stub = await getAgentByName(env.Steward, "owner");
      return stub.fetch(request);
    }

    if (url.pathname === "/pair" && request.method === "POST") {
      if (requestTooLarge(request)) return json({ error: "too_large" }, 413);
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "json_required" }, 415);
      let body: unknown;
      try {
        body = await readJsonObject(request, AUTH_BODY_LIMIT);
      } catch {
        return json({ error: "bad_request" }, 400);
      }
      const { code, name } = (body ?? {}) as { code?: unknown; name?: unknown };
      if (typeof code !== "string" || typeof name !== "string") return json({ error: "bad_request" }, 400);
      const stub = await getAgentByName(env.Steward, "owner");
      const result = await stub.pair(code, name, request.headers.get("CF-Connecting-IP") ?? "unknown");
      if (result.ok) {
        const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
        return json({ deviceId: result.deviceId, token: result.token, wsUrl: `${wsScheme}//${url.host}/agents/steward/owner` });
      }
      if (result.reason === "rate_limited") return rateLimited(result.retryAfterSec);
      return json({ error: "invalid code" }, 400);
    }

    if (url.pathname.startsWith("/api/")) {
      const allowed =
        (url.pathname === "/api/messages" && (request.method === "POST" || request.method === "GET")) ||
        (url.pathname === "/api/actions" && request.method === "POST") ||
        (url.pathname === "/api/pairing" && request.method === "POST") ||
        (url.pathname === "/api/login-link" && request.method === "POST");
      if (!allowed) return new Response("not found", { status: 404 });
      if (!ownerAuthorized(request, env)) return new Response("unauthorized", { status: 401 });
      const stub = await getAgentByName(env.Steward, "owner");
      return stub.fetch(request);
    }

    if (url.pathname.startsWith("/link/") && request.method === "GET") {
      const stub = await getAgentByName(env.Steward, "owner");
      return stub.fetch(request);
    }

    if (url.pathname === "/app/ws") {
      if (!wellFormedSessionCookie(sessionCookie(request))) return json({ error: "auth_required" }, 401);
      url.pathname = "/agents/steward/owner";
      url.searchParams.set("role", "web");
      return routeOwnerSocket(request, env, url);
    }

    if ((url.pathname === "/app" || url.pathname.startsWith("/app/")) && (request.method === "GET" || request.method === "POST")) {
      const stub = await getAgentByName(env.Steward, "owner");
      const response = await stub.fetch(request);
      if (request.method === "GET" && response.status === 204 && response.headers.get("x-sig-workspace-shell") === "1") {
        return workspaceShell(env, url);
      }
      if (request.method === "GET" && response.status === 204 && response.headers.get("x-sig-asset") === "1") {
        return serveAppAsset(env, request, url);
      }
      return response;
    }

    if (url.pathname === "/agents/steward/owner") return routeOwnerSocket(request, env, url);
    return new Response("not found", { status: 404 });
  },
};

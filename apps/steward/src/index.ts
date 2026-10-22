import { getAgentByName, routeAgentRequest } from "agents";
import { parseToken } from "@nightboats/protocol";
import { bearer, resolveServerKeys } from "./auth.ts";
import { AVATAR_PATH, LOGO_PATH, BRAND_HEAD, BRAND_LOCKUP, BRAND_STYLE } from "./brand.ts";
import { Steward } from "./steward.ts";
import { LOGIN_SCRIPT_PATH, mintWebauthnChallenge, parseSessionCookie, verifyLinkToken } from "./web.ts";

export { Steward };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function htmlPage(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// The web's shared "get a fresh link" page (web.ts renders the full variant inside the DO;
// this stateless twin answers rejected probes without waking it).
const LINK_HINT = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Sig</title>${BRAND_HEAD}<style>${BRAND_STYLE}body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:0 16px}main{max-width:480px}</style></head><body><main>${BRAND_LOCKUP}<p>链接无效或已过期。</p><p style="opacity:.75;font-size:13px">新的登录链接用 <code>POST /api/login-link</code> 签发（15 分钟内有效，只能打开一次）。</p></main></body></html>`;

/** The session cookie's raw value, if the request carries one. */
function sessionCookie(request: Request): string | null {
  return (request.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .find((part) => part.startsWith("sig_session="))
    ?.slice("sig_session=".length) ?? null;
}

// Length-independent comparison so the API gate never leaks the key byte-by-byte.
function constantTimeEquals(got: string, want: string): boolean {
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/** ADR-0003: with no chat channel, the owner API is gated by SERVER_KEY itself — whoever can
 *  deploy (or rotate) the secrets is the owner. SERVER_KEY_PREVIOUS is accepted too, so a
 *  client configured with the old key keeps working through a rotation window (issue #27).
 *  Checked here, statelessly, so a bad key never wakes the Durable Object. */
function apiAuthorized(request: Request, env: Env): boolean {
  const got = bearer(request);
  return got !== null && webVerifyKeys(env).some((key) => constantTimeEquals(got, key));
}

// The raw signing secrets for web verification: primary first, SERVER_KEY_PREVIOUS during a
// rotation window (issue #27). Minting always uses [0].
function webVerifyKeys(env: { SERVER_KEY: string; SERVER_KEY_PREVIOUS?: string }): string[] {
  return [env.SERVER_KEY, env.SERVER_KEY_PREVIOUS].filter((k): k is string => typeof k === "string" && k.length > 0);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Brand assets and the pre-session passkey sign-in script are public and do not wake the
    // Durable Object. Everything else continues through the existing authentication gates,
    // including unknown assets.
    if ((request.method === "GET" || request.method === "HEAD") &&
        (url.pathname === LOGO_PATH || url.pathname === AVATAR_PATH || url.pathname === LOGIN_SCRIPT_PATH)) {
      return env.ASSETS.fetch(request);
    }

    // The WebAuthn login ceremony's two legs (candidate-2 design): minting a challenge needs no
    // credential at all, so it is answered entirely by the Worker, with no DO wake — unlike
    // /pair, there is nothing to rate-limit here because nobody has proven anything yet.
    if (url.pathname === "/webauthn/login/options" && request.method === "POST") {
      const { challenge, token, expiresAt } = await mintWebauthnChallenge(webVerifyKeys(env)[0]!, "authenticate", "-");
      return json({ challenge, challengeToken: token, rpId: url.hostname, expiresAt });
    }
    // Verifying an assertion needs the stored public key, which only exists in DO SQLite —
    // there is no stateless pre-check available (the /pair shape, not the /link shape). The
    // body is shape-checked (strings present, non-empty) but not crypto-pre-checked; a bad
    // assertion still wakes the DO once and fails fast there. `request.clone()` lets the body
    // be read here for the shape check AND forwarded intact afterward — reading `request`
    // itself would consume the stream `stub.fetch(request)` needs.
    if (url.pathname === "/webauthn/login/verify" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.clone().json();
      } catch {
        return json({ error: "bad_request" }, 400);
      }
      const a = (body ?? {}) as Record<string, unknown>;
      const keys = ["challengeToken", "credentialId", "clientDataJSON", "authenticatorData", "signature"];
      if (!keys.every((k) => typeof a[k] === "string" && (a[k] as string).length > 0)) {
        return json({ error: "bad_request" }, 400);
      }
      const stub = await getAgentByName(env.Steward, "owner");
      return stub.fetch(request);
    }

    if (url.pathname === "/pair" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_request" }, 400);
      }
      const { code, name } = (body ?? {}) as { code?: unknown; name?: unknown };
      if (typeof code !== "string" || typeof name !== "string") {
        return json({ error: "bad_request" }, 400);
      }
      // CF-Connecting-IP is set by the Cloudflare edge and not client-overridable in
      // production; requests without one (local `wrangler dev`) share the "unknown" bucket.
      const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const stub = await getAgentByName(env.Steward, "owner");
      const result = await stub.pair(code, name, clientIp);
      if (result.ok) {
        const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${wsScheme}//${url.host}/agents/steward/owner`;
        return json({ deviceId: result.deviceId, token: result.token, wsUrl });
      }
      if (result.reason === "rate_limited") {
        // Brute-force lockout (protocol doc §5.2): per-IP and global, 5 failures → 15 min.
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": String(result.retryAfterSec), "cache-control": "no-store" },
        });
      }
      return json({ error: "invalid code" }, 400);
    }

    // The owner API (ADR-0003): the SERVER_KEY bearer is the auth; the Durable Object serves
    // the actual handlers. GET /api/messages is the owner's read side (polling sent rows).
    if (url.pathname.startsWith("/api/") && url.pathname.split("/").length === 3) {
      const allowed =
        (url.pathname === "/api/messages" && (request.method === "POST" || request.method === "GET")) ||
        (url.pathname === "/api/actions" && request.method === "POST") ||
        (url.pathname === "/api/pairing" && request.method === "POST") ||
        (url.pathname === "/api/login-link" && request.method === "POST");
      if (!allowed) return new Response("not found", { status: 404 });
      if (!apiAuthorized(request, env)) return new Response("unauthorized", { status: 401 });
      const stub = await getAgentByName(env.Steward, "owner");
      return stub.fetch(request);
    }
    // The one-time signed link (spec §7.3 / §12.2): possession of a valid HMAC is the auth,
    // the same "stateless pre-check, then forward" pattern as the device token — invalid or
    // expired links are answered here and never wake the Durable Object. The key set includes
    // SERVER_KEY_PREVIOUS during a rotation window (issue #27) so links minted just before a
    // rotation still open until the window closes.
    if (url.pathname.startsWith("/link/") && request.method === "GET") {
      const verified = await verifyLinkToken(webVerifyKeys(env), url.pathname.slice("/link/".length));
      if (!verified) return htmlPage(LINK_HINT, 410);
      const stub = await getAgentByName(env.Steward, "owner");
      return stub.fetch(request);
    }

    // Web app pages: session-cookie gated. A request without a well-formed cookie is rejected
    // here (no DO wake); a well-formed one is forwarded — session liveness stays in the DO.
    // The workspace's JSON API answers JSON (ADR-0004: the static app's fetches), pages the
    // sign-in hint.
    if ((url.pathname === "/app" || url.pathname.startsWith("/app/")) && (request.method === "GET" || request.method === "POST")) {
      const raw = sessionCookie(request);
      if (!(await parseSessionCookie(webVerifyKeys(env), raw))) {
        return url.pathname.startsWith("/app/api/") || url.pathname === "/app/ws"
          ? json({ error: "auth_required" }, 401)
          : htmlPage(LINK_HINT.replace("链接无效或已过期。", "这一页需要先登录。"), 401);
      }
      // The workspace's own static files (ADR-0004): plain HTML/CSS/ES modules under the
      // assets directory, served through the ASSETS binding here — behind the same session
      // gate as the rest of /app, without waking the Durable Object.
      if (request.method === "GET" && url.pathname.startsWith("/app/assets/")) {
        const name = url.pathname.slice("/app/assets/".length);
        if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) return new Response("not found", { status: 404 });
        const asset = await env.ASSETS.fetch(new Request(new URL(`/${name}`, url.origin), request));
        const headers = new Headers(asset.headers);
        headers.set("cache-control", "private, max-age=0, must-revalidate");
        headers.set("x-content-type-options", "nosniff");
        return new Response(asset.body, { status: asset.status, headers });
      }
      // The workspace's browser socket (ADR-0004): the same agent socket as the machines',
      // tagged role=web — onBeforeConnect re-checks the session cookie, and the DO judges
      // liveness. `view` (workspace | session) rides along for the DO's connection tags.
      if (url.pathname === "/app/ws") {
        if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("not found", { status: 404 });
        }
        url.pathname = "/agents/steward/owner";
        url.searchParams.set("role", "web");
        return (await routeAgentRequest(new Request(url, request), env)) ?? new Response("not found", { status: 404 });
      }
      const stub = await getAgentByName(env.Steward, "owner");
      return stub.fetch(request);
    }

    const routed = await routeAgentRequest(request, env, {
      // Stateless pre-check: a bad token never wakes the Durable Object. The key set includes
      // SERVER_KEY_PREVIOUS during a rotation window (issue #27) so existing device tokens
      // keep passing the pre-check until the operator closes the window.
      //
      // role=web (protocol §5.3, issue #23): browser sockets for the L3 raw-process stream.
      // Browsers cannot set Authorization headers, so the session cookie is the credential —
      // MAC-verified here (liveness stays in the DO); every other role needs a device token.
      // SameSite=Lax already keeps cross-site handshakes cookieless in modern browsers; the
      // Origin check is the belt-and-suspenders for older ones (a non-browser client can
      // forge Origin anyway — it isn't the authenticator, the cookie is).
      onBeforeConnect: async (req) => {
        const role = new URL(req.url).searchParams.get("role");
        if (role === "web") {
          const origin = req.headers.get("origin");
          if (origin) {
            let sameHost = false;
            try {
              sameHost = new URL(origin).host === new URL(req.url).host;
            } catch {
              sameHost = false;
            }
            if (!sameHost) return new Response("unauthorized", { status: 401 });
          }
          if (!(await parseSessionCookie(webVerifyKeys(env), sessionCookie(req)))) return new Response("unauthorized", { status: 401 });
          return;
        }
        const parsed = await parseToken(await resolveServerKeys(env), bearer(req));
        if (!parsed) return new Response("unauthorized", { status: 401 });
      },
    });
    return routed ?? new Response("not found", { status: 404 });
  },
};

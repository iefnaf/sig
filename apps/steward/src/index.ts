import { getAgentByName, routeAgentRequest } from "agents";
import { parseToken } from "@shepherd/protocol";
import { bearer, resolveServerKeys } from "./auth.ts";
import { Steward } from "./steward.ts";
import { parseSessionCookie, verifyLinkToken } from "./web.ts";

export { Steward };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function htmlPage(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// The web's shared "get a fresh link" page (web.ts renders the full variant inside the DO;
// this stateless twin answers rejected probes without waking it).
const LINK_HINT = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Shepherd</title><style>body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:0 16px}main{max-width:480px}</style></head><body><main><p>链接无效或已过期。</p><p style="opacity:.75;font-size:13px">在飞书里对总管发 <code>/网页</code>，取一条新的一次性登录链接（15 分钟内有效，只能打开一次）。</p></main></body></html>`;

// Length-independent comparison so the setup gate does not leak the token byte-by-byte.
function setupTokenMatches(got: string | null, want: string): boolean {
  if (!got || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

// The raw signing secrets for web verification: primary first, SERVER_KEY_PREVIOUS during a
// rotation window (issue #27). Minting always uses [0].
function webVerifyKeys(env: { SERVER_KEY: string; SERVER_KEY_PREVIOUS?: string }): string[] {
  return [env.SERVER_KEY, env.SERVER_KEY_PREVIOUS].filter((k): k is string => typeof k === "string" && k.length > 0);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
          headers: { "content-type": "application/json", "retry-after": String(result.retryAfterSec) },
        });
      }
      return json({ error: "invalid code" }, 400);
    }

    // The setup page opens only with SETUP_TOKEN (ADR-0001 decision 8) and 404s otherwise —
    // including once the owner is bound, which the DO decides permanently. The token check is
    // stateless so probes never wake the Durable Object.
    if (url.pathname === "/setup" && (request.method === "GET" || request.method === "POST")) {
      if (!env.SETUP_TOKEN || !setupTokenMatches(url.searchParams.get("token"), env.SETUP_TOKEN)) {
        return new Response("not found", { status: 404 });
      }
      const stub = await getAgentByName(env.Steward, "owner");
      return stub.fetch(request);
    }

    // Feishu event webhook (steward.md §9.1): one of the two unauthenticated entry points
    // (ADR-0001 decision 7) — the DO validates Feishu's verification token itself.
    if (url.pathname === "/channels/feishu/events" && request.method === "POST") {
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
    if ((url.pathname === "/app" || url.pathname.startsWith("/app/")) && (request.method === "GET" || request.method === "POST")) {
      const cookie = request.headers.get("cookie") ?? "";
      const raw = cookie.split(/;\s*/).find((part) => part.startsWith("shepherd_session="))?.slice("shepherd_session=".length) ?? null;
      if (!(await parseSessionCookie(webVerifyKeys(env), raw))) return htmlPage(LINK_HINT.replace("链接无效或已过期。", "这一页需要先登录。"), 401);
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
          const cookie = req.headers.get("cookie") ?? "";
          const raw = cookie
            .split(/;\s*/)
            .find((part) => part.startsWith("shepherd_session="))
            ?.slice("shepherd_session=".length) ?? null;
          if (!(await parseSessionCookie(webVerifyKeys(env), raw))) return new Response("unauthorized", { status: 401 });
          return;
        }
        const parsed = await parseToken(await resolveServerKeys(env), bearer(req));
        if (!parsed) return new Response("unauthorized", { status: 401 });
      },
    });
    return routed ?? new Response("not found", { status: 404 });
  },
};

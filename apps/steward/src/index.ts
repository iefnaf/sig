// The production Worker entry (ADR-0004): the workspace has no password and no Access in
// front of it — a browser that is not signed in only ever sees the sign-in page, and the way
// in is a one-time link minted by an already-paired machine. The first machine gets in by
// redeeming a claim grant that the connector CLI wrote through the Cloudflare API after a
// Wrangler OAuth authorization, so a freshly deployed Pip can only be claimed by someone who
// manages its Cloudflare account.
import { getAgentByName, routeAgentRequest } from "agents";
import { parseToken, type ServerKey } from "@shepherd/protocol";
import { bearer } from "./auth.ts";
import { Steward } from "./steward.ts";
import { SESSION_COOKIE, parseSessionCookie, verifyLinkToken } from "./web.ts";

export { Steward };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const SIGN_IN_SHELL = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Pip · 登录</title><style>body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:0 16px}main{max-width:520px}code{background:#f1f3ed;padding:1px 5px;border-radius:3px;overflow-wrap:anywhere}</style></head><body><main>`;

const SIGN_IN_PAGE = SIGN_IN_SHELL + `<p>请先登录。</p><p>在已配对的电脑上运行 <code>shepherd login</code>，打开它给出的链接（10 分钟内有效，只能用一次）。</p></main></body></html>`;

const SIGN_IN_PAGE_SPENT = SIGN_IN_SHELL + `<p>链接无效、已过期或已使用过。</p><p>在已配对的电脑上重新运行 <code>shepherd login</code> 取一条新链接。</p></main></body></html>`;

/** The Durable Object's signing keys, cached per isolate; a deploy evicts it. */
let authKeysCache: ServerKey[] | undefined;
async function authKeys(env: Env): Promise<ServerKey[]> {
  if (!authKeysCache) authKeysCache = await (await getAgentByName(env.Steward, "owner")).authKeys();
  return authKeysCache;
}

/** The application session cookie's value, if the request carries one. */
function sessionCookie(request: Request): string | null {
  const part = (request.headers.get("cookie") ?? "").split(/;\s*/).find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  return part ? part.slice(SESSION_COOKIE.length + 1) : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseShepherdIdentity(raw: string): { accountId: string; scriptName: string } | null {
  try {
    const parsed = JSON.parse(raw) as { accountId?: unknown; scriptName?: unknown };
    if (typeof parsed.accountId === "string" && typeof parsed.scriptName === "string") return { accountId: parsed.accountId, scriptName: parsed.scriptName };
  } catch { /* fall through */ }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/setup") return Response.redirect(`${url.origin}/app`, 303);

    const stub = await getAgentByName(env.Steward, "owner");

    // A paired machine mints a one-time browser sign-in link (ADR-0004, `shepherd login`).
    // The device credential is the authenticator — the same token the WebSocket takes.
    if (url.pathname === "/login" && request.method === "POST") {
      const keys = await authKeys(env);
      const parsed = await parseToken(keys, bearer(request));
      if (!parsed) return json({ error: "auth_required" }, 401);
      const link = await stub.mintDeviceLoginLink(parsed.deviceId);
      if (!link) return json({ error: "no_origin" }, 409);
      return json({ url: link });
    }

    // The machine door. `connect` redeems a claim grant (first machine) or a pairing code
    // (machines added from the workspace); `login` asks for a browser sign-in link with a
    // device credential. Both are rate-limited by the DO's existing pair lockout.
    if (url.pathname === "/pair" && request.method === "POST") {
      let body: { claimProof?: unknown; code?: unknown; name?: unknown };
      try {
        if (Number(request.headers.get("content-length")) > 4096) return json({ error: "too_large" }, 413);
        const text = await request.text();
        if (text.length > 4096) return json({ error: "too_large" }, 413);
        body = JSON.parse(text) ?? {};
      } catch { return json({ error: "bad_request" }, 400); }
      if (typeof body.name !== "string" || body.name.length > 200) return json({ error: "bad_request" }, 400);
      const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";

      if (typeof body.claimProof === "string") {
        // The claim secret was written through the Cloudflare API moments ago (claim.ts):
        // only someone with workers_scripts:write for this account could have. Comparing
        // SHA-256 hashes keeps the secret itself out of the request; the comparison is
        // length-independent so nothing leaks byte-by-byte.
        const secret = env.SHEPHERD_CLAIM_SECRET;
        if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(body.claimProof)) return json({ error: "invalid_claim" }, 401);
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)))].map((b) => b.toString(16).padStart(2, "0")).join("");
        if (digest.length !== body.claimProof.length || !timingSafeEqual(digest, body.claimProof)) return json({ error: "invalid_claim" }, 401);
        const identity = parseShepherdIdentity(env.SHEPHERD_IDENTITY ?? "");
        const result = await stub.redeemClaim({ accountId: identity?.accountId ?? "unknown", scriptName: identity?.scriptName ?? "unknown", nonce: body.claimProof.slice(0, 32), expiresAt: Date.now() + 1 }, body.name);
        if (!result.ok) return json({ error: result.reason }, result.reason === "already_claimed" ? 403 : 401);
        await stub.recordOrigin(url.origin);
        return json({ deviceId: result.deviceId, token: result.token, wsUrl: `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/agents/steward/owner`, loginUrl: await stub.mintDeviceLoginLink(result.deviceId) });
      }

      if (typeof body.code !== "string") return json({ error: "bad_request" }, 400);
      const result = await stub.pair(body.code, body.name, clientIp);
      if (result.ok) return json({ deviceId: result.deviceId, token: result.token, wsUrl: `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/agents/steward/owner` });
      if (result.reason === "rate_limited") return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(result.retryAfterSec), "cache-control": "no-store" } });
      return json({ error: "invalid code" }, 400);
    }

    // The one-time sign-in link (ADR-0004): possession of a valid HMAC is the auth — the same
    // stateless pre-check as the device token; single-use is decided in the DO.
    if (url.pathname.startsWith("/link/") && request.method === "GET") {
      const verified = await verifyLinkToken((await authKeys(env)).map((k) => k.secret), url.pathname.slice("/link/".length));
      if (!verified) return new Response(SIGN_IN_PAGE_SPENT, { status: 410, headers: { "content-type": "text/html; charset=utf-8" } });
      return stub.fetch(request);
    }

    const browser = url.pathname === "/app" || url.pathname.startsWith("/app/");
    const connector = url.pathname === "/agents/steward/owner";
    if (!browser && !connector) return new Response("not found", { status: 404 });

    if (browser) {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);
      const keys = (await authKeys(env)).map((k) => k.secret);
      if (url.pathname === "/app/ws") {
        // A socket also needs the application session (its liveness is the Durable Object's to judge):
        // a request without even a well-formed one never wakes it.
        if (!(await parseSessionCookie(keys, sessionCookie(request)))) return json({ error: "auth_required" }, 401);
      } else {
        // The workspace's script, styles and logo: static files behind the same session gate.
        if (!(await parseSessionCookie(keys, sessionCookie(request)))) {
          return url.pathname.startsWith("/app/api/")
            ? json({ error: "auth_required" }, 401)
            : new Response(SIGN_IN_PAGE, { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        }
        if (request.method === "GET" && url.pathname.startsWith("/app/assets/")) {
          const name = url.pathname.slice("/app/assets/".length);
          if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) return new Response("not found", { status: 404 });
          const asset = await env.ASSETS.fetch(new Request(new URL(`/${name}`, url.origin), request));
          const headers = new Headers(asset.headers);
          headers.set("cache-control", "private, max-age=0, must-revalidate");
          headers.set("x-content-type-options", "nosniff");
          return new Response(asset.body, { status: asset.status, headers });
        }
        return stub.fetch(request);
      }
    } else {
      // The machines' socket. A machine says what it is (`role=connector`); it cannot claim to be a browser.
      if (url.searchParams.has("role") && url.searchParams.get("role") !== "connector") return json({ error: "forbidden" }, 403);
      if (!(await parseToken(await authKeys(env), bearer(request)))) return json({ error: "auth_required" }, 401);
    }

    // No ordinary HTTP or SDK RPC traffic can enter the Agent router from the public Internet.
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || request.method !== "GET") return new Response("not found", { status: 404 });
    url.pathname = "/agents/steward/owner";
    url.searchParams.set("role", browser ? "web" : "connector");
    return (await routeAgentRequest(new Request(url, request), env)) ?? new Response("not found", { status: 404 });
  },
};

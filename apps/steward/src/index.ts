import { getAgentByName, routeAgentRequest } from "agents";
import { parseToken } from "@shepherd/protocol";
import { bearer } from "./auth.ts";
import { Steward } from "./steward.ts";

export { Steward };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// Length-independent comparison so the setup gate does not leak the token byte-by-byte.
function setupTokenMatches(got: string | null, want: string): boolean {
  if (!got || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
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
      const stub = await getAgentByName(env.Steward, "owner");
      const result = await stub.pair(code, name);
      if (!result) return json({ error: "invalid code" }, 400);
      const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsScheme}//${url.host}/agents/steward/owner`;
      return json({ ...result, wsUrl });
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

    const routed = await routeAgentRequest(request, env, {
      // Stateless pre-check: a bad token never wakes the Durable Object.
      onBeforeConnect: async (req) => {
        const parsed = await parseToken(env.SERVER_KEY, bearer(req));
        if (!parsed) return new Response("unauthorized", { status: 401 });
      },
    });
    return routed ?? new Response("not found", { status: 404 });
  },
};

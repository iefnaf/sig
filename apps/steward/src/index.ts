import { getAgentByName, routeAgentRequest } from "agents";
import { parseToken } from "@shepherd/protocol";
import { bearer } from "./auth.ts";
import { Steward } from "./steward.ts";

export { Steward };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
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

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Programmable Feishu stand-in (service binding). The DO's adapter calls it instead of the
// real open.feishu.cn when the FEISHU_API binding exists (see newFeishuAdapter). Tests steer
// it through control URLs on the same binding:
//   POST /__control/queue  {status?, body?, delayMs?} | array — replies consumed FIFO by API calls
//   POST /__control/calls  — returns and clears the recorded API calls
//   POST /__control/reset  — clears queue and call log
interface MockReply {
  status?: number;
  body?: unknown;
  delayMs?: number;
}
interface RecordedCall {
  method: string;
  path: string;
  body: string | null;
  at: number;
}

const replyQueue: MockReply[] = [];
const calls: RecordedCall[] = [];
let messageCounter = 0;

function defaultReply(path: string): MockReply {
  if (path.startsWith("/open-apis/auth/v3/tenant_access_token")) {
    return { body: { code: 0, tenant_access_token: `t_mock_${Date.now()}`, expire: 7200 } };
  }
  if (path.startsWith("/open-apis/im/v1/messages")) {
    return { body: { code: 0, data: { message_id: `om_mock_${++messageCounter}` } } };
  }
  return { body: { code: 0 } };
}

const feishuMock = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/__control/")) {
    const body = request.method === "POST" ? await request.text() : "";
    if (url.pathname === "/__control/queue") {
      const parsed = body ? JSON.parse(body) : null;
      replyQueue.push(...(Array.isArray(parsed) ? (parsed as MockReply[]) : [parsed as MockReply].filter(Boolean)));
      return new Response("ok");
    }
    if (url.pathname === "/__control/calls") {
      const drained = calls.splice(0, calls.length);
      return Response.json(drained);
    }
    if (url.pathname === "/__control/reset") {
      replyQueue.splice(0, replyQueue.length);
      calls.splice(0, calls.length);
      return new Response("ok");
    }
    return new Response("unknown control", { status: 404 });
  }

  calls.push({ method: request.method, path: url.pathname + url.search, body: request.method === "GET" ? null : await request.text(), at: Date.now() });
  const reply = replyQueue.shift() ?? defaultReply(url.pathname);
  if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
  if (url.pathname.includes("/resources/")) {
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: reply.status ?? 200 });
  }
  return Response.json(reply.body ?? { code: 0 }, { status: reply.status ?? 200 });
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // SERVER_KEY and SETUP_TOKEN are `wrangler secret put` values in real deployments; tests
      // supply deterministic stand-ins instead of relying on committed or ambient secrets.
      miniflare: {
        bindings: { SERVER_KEY: "test-server-key-not-a-secret", SETUP_TOKEN: "test-setup-token-not-a-secret" },
        serviceBindings: { FEISHU_API: feishuMock },
      },
    }),
  ],
  // One workerd instance backs every file here, and the Durable Object's SQLite plus the
  // node-side Feishu mock are shared mutable state that per-test storage isolation does not
  // cover — so files must run one at a time for exact-count assertions to stay meaningful.
  test: { fileParallelism: false },
});

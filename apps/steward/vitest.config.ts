import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Programmable Feishu stand-in (service binding). The DO's adapter calls it instead of the
// real open.feishu.cn when the FEISHU_API binding exists (see newFeishuAdapter), and the
// device-flow client (registration.ts) reaches it for accounts.feishu.cn too — the binding is
// host-agnostic. Tests steer it through control URLs on the same binding:
//   POST /__control/queue         {status?, body?, delayMs?} | array — replies consumed FIFO by API calls
//   POST /__control/calls         — returns and clears the recorded API calls
//   POST /__control/reset         — clears queue, call log, and the registration script
//   POST /__control/registration  {begin?, polls?} — device-flow script: `begin` overrides the
//                                  begin reply; `polls` is consumed FIFO with the last entry
//                                  repeating (default: authorization_pending forever)
interface MockReply {
  status?: number;
  body?: unknown;
  delayMs?: number;
}
interface RecordedCall {
  method: string;
  path: string;
  url: string;
  body: string | null;
  at: number;
}
interface RegistrationScript {
  begin?: unknown[];
  polls?: unknown[];
}

const replyQueue: MockReply[] = [];
const calls: RecordedCall[] = [];
let registration: RegistrationScript = {};
let messageCounter = 0;

function defaultBegin(): unknown {
  return {
    device_code: "dc_mock_create",
    verification_uri: "https://feishu.invalid/qr",
    verification_uri_complete: "https://feishu.invalid/qr/confirm?dc=dc_mock_create",
    user_code: "MOCK-CODE",
    interval: 1, // fast polling so alarm-driven tests settle in seconds
    expires_in: 600,
  };
}

function defaultReply(path: string): MockReply {
  if (path.startsWith("/oauth/v1/app/registration")) {
    return { body: { error: "authorization_pending" } };
  }
  if (path.startsWith("/open-apis/auth/v3/tenant_access_token")) {
    return { body: { code: 0, tenant_access_token: `t_mock_${Date.now()}`, expire: 7200 } };
  }
  if (path.startsWith("/open-apis/im/v1/messages")) {
    return { body: { code: 0, data: { message_id: `om_mock_${++messageCounter}` } } };
  }
  if (path.includes("/open-apis/application/v7/applications/")) {
    return { body: { code: 0 } };
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
      registration = {};
      return new Response("ok");
    }
    if (url.pathname === "/__control/registration") {
      registration = body ? (JSON.parse(body) as RegistrationScript) : {};
      return new Response("ok");
    }
    return new Response("unknown control", { status: 404 });
  }

  const body = request.method === "GET" ? null : await request.text();
  calls.push({ method: request.method, path: url.pathname + url.search, url: url.origin + url.pathname + url.search, body, at: Date.now() });

  // The device flow is scripted separately so its alarm-driven polling never steals replies
  // from the shared FIFO queue (and vice versa).
  if (url.pathname === "/oauth/v1/app/registration") {
    const params = new URLSearchParams(request.method === "POST" ? body ?? "" : "");
    if (params.get("action") === "begin") {
      // `begin` is an array consumed FIFO per begin call (the last entry repeats): the QR
      // flow chains a second begin the moment the create scan succeeds.
      const begins = registration.begin ?? [];
      const reply = begins.length > 1 ? begins.shift() : begins[0];
      return Response.json((reply ?? defaultBegin()) as Record<string, unknown>);
    }
    const polls = registration.polls ?? [];
    const reply = polls.length > 1 ? polls.shift() : polls[0];
    return Response.json((reply ?? { error: "authorization_pending" }) as Record<string, unknown>);
  }

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
      // The Worker's config lives at the repo root (issue #25: Deploy-to-Cloudflare reads it
      // there); paths inside it resolve relative to the config file.
      wrangler: { configPath: "../../wrangler.jsonc" },
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

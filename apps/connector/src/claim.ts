// `connect` without a pairing code (ADR-0004): claim a freshly deployed Pip by proving, to
// Cloudflare itself, that this terminal manages the account that owns the deployment.
//
// The proof: Wrangler's OAuth token (npx wrangler login, account:read + workers_scripts:write)
//   → find the exact Worker behind this URL among the account's workers and domains
//   → generate a random claim secret, install it as the Worker's SHEPHERD_CLAIM_SECRET
//     through the Cloudflare API (only someone with workers_scripts:write for THIS account
//     can), and send its SHA-256 in the redeem request
//   → POST /pair { claimProof }: the Worker hashes its own SHEPHERD_CLAIM_SECRET and compares
//     — a match proves the caller just wrote that secret through Cloudflare's API.
//
// The secret is one-time in practice: redeeming deletes it (the Worker PATCHes it away), and a
// claimed deployment refuses every later claim. No Cloudflare token ever reaches the
// deployment; the deployment learns only "whoever can manage me in Cloudflare says connect".
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

export interface ClaimContext {
  serverUrl: string;
  machineName: string;
  fetchImpl?: typeof fetch;
  /** Test seam: runs `npx` (or a stub). */
  run?: (args: string[], env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };
  log?: (line: string) => void;
}

export interface ClaimResult {
  deviceId: string;
  token: string;
  wsUrl: string;
  loginUrl?: string;
}

const CF_API = "https://api.cloudflare.com/client/v4";

function defaultRun(args: string[], env: NodeJS.ProcessEnv) {
  // Run npx from a neutral cwd: inside a pnpm workspace (or any project with a local
  // node_modules), npx prefers the local tree and can resolve a broken shim; from a clean
  // directory it fetches wrangler from the registry. shell for npx shims / Windows npx.cmd.
  const res = spawnSync("npx", ["-y", ...args], { encoding: "utf8", env, shell: true, cwd: tmpdir() });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function wrangler(ctx: ClaimContext, args: string[]): string {
  const run = ctx.run ?? defaultRun;
  const res = run(["wrangler", ...args], { ...process.env });
  if (res.status !== 0) {
    throw new Error(`wrangler ${args[0]} failed: ${(res.stderr || res.stdout).trim().split("\n").slice(-3).join(" ")}`);
  }
  return res.stdout;
}

/** Wrangler's OAuth token (wrangler login stores it on this machine). */
function oauthToken(ctx: ClaimContext): string {
  const out = wrangler(ctx, ["auth", "token", "--json"]);
  let parsed: { type?: string; token?: string };
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error("could not read wrangler credentials — run `npx wrangler login` first (scopes: account:read, workers_scripts:write)");
  }
  if (parsed.type !== "oauth" || !parsed.token) {
    throw new Error("wrangler is not logged in with OAuth — run `npx wrangler login` first");
  }
  return parsed.token;
}

async function cf(ctx: ClaimContext, token: string, path: string, init?: RequestInit): Promise<unknown> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const res = await fetchImpl(`${CF_API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers as Record<string, string> | undefined) },
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> };
  if (!res.ok || body.success === false) {
    throw new Error(`Cloudflare API ${path} failed: ${body.errors?.map((e) => e.message).join("; ") ?? res.status}`);
  }
  return body.result;
}

/** The account id + script name that serve this URL, or null when this account doesn't own it. */
export async function resolveTarget(ctx: ClaimContext, token: string): Promise<{ accountId: string; scriptName: string } | null> {
  const hostname = new URL(ctx.serverUrl).hostname;
  const accounts = (await cf(ctx, token, "/accounts")) as Array<{ id: string; name: string }>;
  for (const account of accounts) {
    const domains = (await cf(ctx, token, `/accounts/${account.id}/workers/domains?per_page=100`)) as Array<{ hostname: string; service: string }>;
    const hit = domains.find((d) => d.hostname === hostname);
    if (hit) return { accountId: account.id, scriptName: hit.service };
    // workers.dev: the hostname is <script>.<account-subdomain>.workers.dev — exactly four
    // labels, the first naming the script. The account must own a script by that name; if it
    // does not, the secret write below could not target this URL's Worker anyway, and the
    // redeem would fail its proof. (The API lists scripts under `id`, `name` is null.)
    const labels = hostname.split(".");
    if (labels.length === 4 && labels.slice(-2).join(".") === "workers.dev") {
      const scriptName = labels[0]!;
      const services = (await cf(ctx, token, `/accounts/${account.id}/workers/services?per_page=100`)) as Array<{ id?: string; name?: string }>;
      if (services.some((w) => (w.id ?? w.name) === scriptName)) return { accountId: account.id, scriptName };
    }
  }
  return null;
}

/**
 * Claims the deployment at serverUrl, or throws with a readable message: not logged in, the
 * URL is not a Worker this account owns, the deployment is already claimed, redeem rejected.
 */
export async function claimDeployment(ctx: ClaimContext): Promise<ClaimResult> {
  const say = ctx.log ?? (() => {});
  const fetchImpl = ctx.fetchImpl ?? fetch;

  say("Authorizing with Cloudflare (wrangler login; scopes account:read + workers_scripts:write)…");
  const token = oauthToken(ctx);
  const host = new URL(ctx.serverUrl).hostname;
  say(`Finding the deployment behind ${host}…`);
  const target = await resolveTarget(ctx, token);
  if (!target) {
    throw new Error(`${host} is not a Worker in your Cloudflare account. Check the URL, or \`npx wrangler login\` with the account that deployed it.`);
  }

  const secret = randomBytes(32).toString("hex");
  say(`Writing a one-time claim secret to ${target.scriptName} (account ${target.accountId})…`);
  await cf(ctx, token, `/accounts/${target.accountId}/workers/scripts/${target.scriptName}/secrets`, {
    method: "PUT",
    body: JSON.stringify({ name: "SHEPHERD_CLAIM_SECRET", text: secret, type: "secret_text" }),
  });

  // The secret write ships a new Worker version; it takes a few seconds to serve everywhere.
  // Same proof each time (the secret was written once), a handful of tries, then give up.
  const proof = createHash("sha256").update(secret).digest("hex");
  say("Redeeming the claim…");
  let lastError = "invalid_claim";
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 4000));
    const res = await fetchImpl(new URL("/pair", ctx.serverUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimProof: proof, name: ctx.machineName }),
    });
    if (res.ok) return (await res.json()) as unknown as ClaimResult;
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.error === "already_claimed") throw new Error("this Pip is already claimed");
    lastError = String(body.error ?? res.status);
    if (body.error !== "invalid_claim") break; // anything else (e.g. rate_limited) won't fix itself
  }
  throw new Error(`claim rejected: ${lastError}`);
}

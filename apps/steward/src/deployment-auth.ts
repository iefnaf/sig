import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SqlExecutor } from "./schema.ts";

interface AuthEnvironment {
  SERVER_KEY?: string;
  SERVER_KEY_PREVIOUS?: string;
  LOGIN_PASSWORD?: string;
}

type PasswordRow = { salt: string; digest: string; revision: string };
type LimitRow = { attempts: number; windowStart: number; failures: number; blockedUntil: number };
type PasswordPurpose = "password" | "passkey";
type PasswordScreening = (password: string) => Promise<boolean>;
type PasswordUnavailable = "password_not_configured" | "password_rejected" | "password_screening_unavailable" | "password_unavailable";
type PasswordAvailability = "ready" | PasswordUnavailable;
type PasswordVerification = "valid" | "invalid" | PasswordUnavailable;

export type Admission = { allowed: true } | { allowed: false; retryAfterSec: number };

// Cloudflare Workers rejects PBKDF2 above 100,000 iterations (NotSupportedError), while local
// workerd accepts more. Raising this breaks password setup on every real deployment.
export const PBKDF2_ITERATIONS = 100_000;
const PASSWORD_MAX_CODE_POINTS = 128;
const PASSWORD_MAX_BYTES = 1024;
const LIMIT_WINDOW_MS = 60_000;
const LIMIT_ROW_TTL_MS = 60 * 60_000;
const SCREENING_RETRY_MS = 60_000;

/**
 * Deployment keys live in the owner Durable Object for fresh installs. Explicit SERVER_KEY
 * deployments keep their operator-managed key and rotation window unchanged.
 */
export function deploymentSecrets(sql: SqlExecutor, env: AuthEnvironment): [string, ...string[]] {
  // Presence, not truthiness, selects explicit mode. A missing or empty operator secret must
  // fail closed on an existing deployment rather than silently generating a replacement key.
  const initialMode = env.SERVER_KEY !== undefined || env.SERVER_KEY_PREVIOUS !== undefined ? "explicit" : "generated";
  sql`INSERT OR IGNORE INTO sh_auth_deployment (id, mode, secret)
    VALUES (0, ${initialMode}, ${initialMode === "generated" ? randomBytes(32).toString("hex") : null})`;
  const row = sql<{ mode: string; secret: string | null }>`SELECT mode, secret FROM sh_auth_deployment WHERE id = 0`[0];
  if (row?.mode === "explicit") {
    if (!env.SERVER_KEY) throw new Error("Preserve SERVER_KEY on an existing deployment");
    return env.SERVER_KEY_PREVIOUS ? [env.SERVER_KEY, env.SERVER_KEY_PREVIOUS] : [env.SERVER_KEY];
  }
  if (row?.mode !== "generated" || !row.secret || !/^[0-9a-f]{64}$/.test(row.secret)) {
    throw new Error("Generated signing keys are unavailable");
  }
  if (env.SERVER_KEY || env.SERVER_KEY_PREVIOUS) {
    throw new Error("Generated signing keys cannot be replaced with SERVER_KEY");
  }
  return [row.secret];
}

export function ownerAuthorized(request: Request, env: AuthEnvironment): boolean {
  const credential = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!credential || !env.SERVER_KEY) return false;
  return [env.SERVER_KEY, env.SERVER_KEY_PREVIOUS].some((secret) => {
    if (!secret) return false;
    return safeEqual(Buffer.from(credential), Buffer.from(secret));
  });
}

/** PBKDF2-HMAC-SHA-256 is available in Workers without a platform-specific native module. */
export async function passwordDigest(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toHex(bits)}`;
}

async function matches(password: string, row: PasswordRow): Promise<boolean> {
  const expected = row.digest.split("$");
  if (expected.length !== 3 || expected[0] !== "pbkdf2-sha256" || Number(expected[1]) !== PBKDF2_ITERATIONS) return false;
  const digest = (await passwordDigest(password, row.salt)).split("$")[2];
  return digest !== undefined && safeEqual(Buffer.from(digest, "hex"), Buffer.from(expected[2]!, "hex"));
}

/** A bounded Have I Been Pwned range query; the password and its full digest never leave here. */
export async function screenPassword(password: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const length = [...password].length;
  if (length < 15 || length > PASSWORD_MAX_CODE_POINTS || Buffer.byteLength(password) > PASSWORD_MAX_BYTES) return false;
  const normalized = password.normalize("NFC").toLocaleLowerCase("en-US");
  if (/^(.)\1+$/u.test(normalized) || /^(password|passphrase|1234567890|qwerty|letmein|admin)[\d\W]*$/u.test(normalized)) {
    return false;
  }
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
  const hash = toHex(digest).toUpperCase();
  const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
    headers: {
      "Add-Padding": "true",
      "User-Agent": "Sig deployment password screening (https://github.com/iefnaf/sig)",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("password screening unavailable");
  const entries = (await response.text()).trim().split(/\r?\n/);
  if (entries.length === 0 || entries.some((entry) => !/^[A-F0-9]{35}:\d+$/.test(entry))) {
    throw new Error("invalid password screening response");
  }
  return !entries.some((entry) => {
    const [suffix, count] = entry.split(":");
    return suffix === hash.slice(5) && Number(count) > 0;
  });
}

export class DeploymentAuth {
  readonly #sql: SqlExecutor;
  readonly #env: AuthEnvironment;
  readonly #transaction: <Value>(operation: () => Value) => Value;
  readonly #sessionsRevoked: () => void;
  readonly #audit: (reason: string, detail: string) => void;
  readonly #screenPassword: PasswordScreening;
  #ready: Promise<void> | undefined;
  #screeningRetryAt = 0;
  #availability: PasswordAvailability = "password_unavailable";
  #configuredOverride: string | undefined;

  constructor(input: {
    sql: SqlExecutor;
    env: AuthEnvironment;
    transaction: <Value>(operation: () => Value) => Value;
    sessionsRevoked: () => void;
    audit?: (reason: string, detail: string) => void;
    screenPassword?: PasswordScreening;
  }) {
    this.#sql = input.sql;
    this.#env = input.env;
    this.#transaction = input.transaction;
    this.#sessionsRevoked = input.sessionsRevoked;
    this.#audit = input.audit ?? (() => {});
    this.#screenPassword = input.screenPassword ?? screenPassword;
  }

  /** Reconcile the Cloudflare Secret once per isolate and revoke stale browser authority. */
  ready(): Promise<void> {
    if (this.#ready) return this.#ready;
    if (Date.now() < this.#screeningRetryAt) return Promise.resolve();
    const pending = this.#synchronize();
    this.#ready = pending;
    pending.then(
      () => {
        // A temporary screening outage leaves no verifier. Allow a later attempt instead of
        // pinning password setup off for the life of the isolate.
        if (this.#ready === pending && this.#screeningRetryAt > Date.now()) this.#ready = undefined;
      },
      () => {
        if (this.#ready === pending) this.#ready = undefined;
      },
    );
    return pending;
  }

  async #synchronize(): Promise<void> {
    const configured = (this.#configuredOverride ?? this.#env.LOGIN_PASSWORD)?.normalize("NFC");
    const previous = this.#sql<PasswordRow>`SELECT salt, digest, revision FROM sh_auth_password WHERE id = 0`[0];
    if (configured && previous && await matches(configured, previous)) {
      this.#availability = "ready";
      return;
    }

    let replacement: PasswordRow | undefined;
    let unavailable: PasswordUnavailable = "password_not_configured";
    if (configured) {
      let accepted = false;
      try {
        accepted = await this.#screenPassword(configured);
        if (!accepted) {
          unavailable = "password_rejected";
          console.error("Browser password rejected by the deployment password policy");
          this.#audit("browser_password_rejected", "configured_secret");
        }
      } catch (error) {
        unavailable = "password_screening_unavailable";
        this.#screeningRetryAt = Date.now() + SCREENING_RETRY_MS;
        console.error("Browser password screening unavailable", error instanceof Error ? error.message : String(error));
        this.#audit("browser_password_screening_unavailable", "retry_scheduled");
      }
      // Deriving the verifier is local work, not the screening service: report its failure as
      // its own fault instead of telling the owner to wait for an outage that does not exist.
      if (accepted) {
        try {
          const salt = randomBytes(16).toString("hex");
          replacement = { salt, digest: await passwordDigest(configured, salt), revision: crypto.randomUUID() };
        } catch (error) {
          unavailable = "password_unavailable";
          console.error("Browser password verifier derivation failed", error instanceof Error ? error.message : String(error));
          this.#audit("browser_password_verifier_failed", "configured_secret");
        }
      }
    }

    if (previous || replacement) {
      this.#transaction(() => {
        this.#sql`DELETE FROM sh_auth_password`;
        if (replacement) {
          this.#sql`INSERT INTO sh_auth_password (id, salt, digest, revision)
            VALUES (0, ${replacement.salt}, ${replacement.digest}, ${replacement.revision})`;
        }
        // A new verifier starts with a clean admission state, including first-time setup after
        // a temporary screening outage that anonymous requests may have exercised.
        this.#sql`DELETE FROM sh_auth_limit`;
        // First-time password provisioning must not invalidate links/sessions opened before
        // the password existed. Only an actual password replacement or removal revokes them.
        if (previous) {
          this.#sql`DELETE FROM sh_web_session`;
          this.#sql`DELETE FROM sh_web_link`;
        }
      });
    }
    this.#availability = replacement ? "ready" : unavailable;
    if (previous) {
      this.#audit("browser_password_reset", replacement ? "replaced" : "removed");
      this.#sessionsRevoked();
    } else if (replacement) {
      this.#audit("browser_password_provisioned", "configured_secret");
    }
  }

  /** Test seam for dedicated workerd runs: install a verifier without an external HIBP call. */
  async provisionForTests(password: string): Promise<void> {
    const normalized = password.normalize("NFC");
    const salt = randomBytes(16).toString("hex");
    const row = { salt, digest: await passwordDigest(normalized, salt), revision: crypto.randomUUID() };
    const previous = this.#sql<PasswordRow>`SELECT salt, digest, revision FROM sh_auth_password WHERE id = 0`[0];
    this.#transaction(() => {
      this.#sql`DELETE FROM sh_auth_password`;
      this.#sql`INSERT INTO sh_auth_password (id, salt, digest, revision)
        VALUES (0, ${row.salt}, ${row.digest}, ${row.revision})`;
      this.#sql`DELETE FROM sh_web_session`;
      this.#sql`DELETE FROM sh_web_link`;
      this.#sql`DELETE FROM sh_auth_limit`;
    });
    this.#configuredOverride = normalized;
    this.#availability = "ready";
    this.#screeningRetryAt = 0;
    this.#ready = undefined;
    if (previous) {
      this.#audit("browser_password_reset", "replaced");
      this.#sessionsRevoked();
    } else {
      this.#audit("browser_password_provisioned", "test_verifier");
    }
  }

  /**
   * Reserve an attempt before password hashing or assertion verification. Both the IP and
   * deployment-wide bucket are updated in one synchronous transaction, so concurrent requests
   * cannot all read the same pre-limit count.
   */
  admit(purpose: PasswordPurpose, ip: string, now = Date.now()): Admission {
    return this.#transaction(() => {
      this.#sql`DELETE FROM sh_auth_limit WHERE expiresAt <= ${now}`;
      const buckets = [
        { key: `${purpose}:global`, maximum: purpose === "password" ? 20 : 100 },
        { key: `${purpose}:ip:${ip}`, maximum: purpose === "password" ? 5 : 20 },
      ];
      for (const bucket of buckets) {
        const row = this.#sql<LimitRow>`SELECT attempts, windowStart, failures, blockedUntil
          FROM sh_auth_limit WHERE bucket = ${bucket.key}`[0];
        const windowBlockedUntil = row && row.windowStart + LIMIT_WINDOW_MS > now && row.attempts >= bucket.maximum
          ? row.windowStart + LIMIT_WINDOW_MS
          : 0;
        const blockedUntil = Math.max(row?.blockedUntil ?? 0, windowBlockedUntil);
        if (blockedUntil > now) return { allowed: false, retryAfterSec: Math.ceil((blockedUntil - now) / 1000) };
      }
      for (const bucket of buckets) {
        this.#sql`INSERT INTO sh_auth_limit (bucket, windowStart, attempts, failures, blockedUntil, expiresAt)
          VALUES (${bucket.key}, ${now}, 1, 0, 0, ${now + LIMIT_ROW_TTL_MS})
          ON CONFLICT(bucket) DO UPDATE SET
            attempts = CASE WHEN windowStart + ${LIMIT_WINDOW_MS} <= ${now} THEN 1 ELSE attempts + 1 END,
            windowStart = CASE WHEN windowStart + ${LIMIT_WINDOW_MS} <= ${now} THEN ${now} ELSE windowStart END,
            expiresAt = ${now + LIMIT_ROW_TTL_MS}`;
      }
      return { allowed: true };
    });
  }

  async verifyPassword(password: string, ip: string): Promise<PasswordVerification> {
    await this.ready();
    const row = this.#sql<PasswordRow>`SELECT salt, digest, revision FROM sh_auth_password WHERE id = 0`[0];
    if (this.#availability !== "ready") return this.#availability;
    if (!row) return "password_unavailable";
    const valid = await matches(password.normalize("NFC"), row);
    if (this.#sql<{ revision: string }>`SELECT revision FROM sh_auth_password WHERE id = 0`[0]?.revision !== row.revision) {
      return "invalid";
    }
    const bucket = `password:ip:${ip}`;
    if (valid) {
      this.#sql`UPDATE sh_auth_limit SET failures = 0, blockedUntil = 0 WHERE bucket = ${bucket}`;
      return "valid";
    }
    const failures = (this.#sql<{ failures: number }>`SELECT failures FROM sh_auth_limit WHERE bucket = ${bucket}`[0]?.failures ?? 0) + 1;
    const blockedUntil = failures < 5 ? 0 : Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(failures - 5, 5));
    this.#sql`UPDATE sh_auth_limit SET failures = ${failures}, blockedUntil = ${blockedUntil} WHERE bucket = ${bucket}`;
    return "invalid";
  }
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) throw new Error("invalid salt");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function safeEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

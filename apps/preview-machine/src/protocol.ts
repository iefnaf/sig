import { PROTOCOL_VERSION } from "@nightboats/protocol";

export type MachinePhase = "unpaired" | "connecting" | "welcomed" | "disconnected" | "error";

export interface StoredCredentials {
  serverUrl: string;
  deviceId: string;
  token: string;
}

export interface WorkerSnapshot {
  workerId: string;
  agent: string;
  state: string;
  lastSeq: number;
  sessionId: string;
  lastOutcome: string;
}

export function buildHello(
  credentials: Pick<StoredCredentials, "deviceId">,
  bootId: string,
  connEpoch: number,
  workers: readonly WorkerSnapshot[],
): Record<string, unknown> {
  return {
    t: "hello",
    id: `hello-${crypto.randomUUID()}`,
    protocol: PROTOCOL_VERSION,
    deviceId: credentials.deviceId,
    bootId,
    connEpoch,
    connector: { version: "0.0.0", os: "linux", arch: "arm64", node: "cloudflare-workers" },
    machine: { name: "preview-machine", memTotalMB: 16384, memFreeMB: 12288 },
    agents: [
      {
        kind: "pi",
        version: "0.0.0",
        capabilities: {
          steer: true,
          followUp: true,
          interrupt: true,
          resume: true,
          history: false,
          images: true,
          structuredReport: true,
          readonly: true,
        },
      },
    ],
    repos: [
      {
        repoId: "/srv/repo-a",
        name: "repo-a",
        path: "/srv/repo-a",
        defaultBranch: "main",
        remote: "git@github.com:example/repo-a.git",
      },
    ],
    limits: { maxWorkers: 4, running: 0 },
    workers,
    pendingAcks: [],
  };
}

export function workerEvent(
  workerId: string,
  seq: number,
  type: "started" | "progress" | "report" | "settled",
  fields: Record<string, unknown>,
  ts = Date.now(),
): { id: string; batch: Array<Record<string, unknown>> } {
  return {
    id: `evt-${workerId}-${seq}`,
    batch: [{ workerId, seq, ts, type, ...fields }],
  };
}

export function scriptForStartWorker(
  args: Record<string, unknown>,
): {
  ok: true;
  data: { sessionId: string; branch: string; cwd: string };
  git: { branch: string; base: string; ahead: number; dirty: number; filesChanged: number; insertions: number; deletions: number };
  workerId: string;
} | { ok: false; error: { code: string } } {
  const workerId = args.workerId;
  if (typeof workerId !== "string" || workerId.length === 0) {
    return { ok: false, error: { code: "bad_worker_id" } };
  }
  const threadId = typeof args.threadId === "string" ? args.threadId.replace(/[^a-zA-Z0-9._-]/g, "") : "preview";
  const branch = `sig/${threadId || "preview"}-1`;
  return {
    ok: true,
    workerId,
    data: {
      sessionId: workerId,
      branch,
      cwd: "/srv/repo-a",
    },
    git: {
      branch,
      base: "main",
      ahead: 0,
      dirty: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    },
  };
}

// The connector's on-disk logger (connector-pi.md §12): JSONL under ~/.sig/logs/,
// capped, with secrets redacted before anything is written. Session content never reaches
// this logger by construction — callers log ids, codes and event types only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "./redact.ts";

export const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;

export interface LoggerOptions {
  dir: string;
  file?: string;
  /** Rotate once the file grows past this (default 1 MiB, keeping the newest half). */
  maxBytes?: number;
  /** Concrete secret values (e.g. the device token) replaced wherever they appear. */
  secrets?: string[];
  now?: () => number;
}

export type LogLevel = "info" | "warn" | "error";

export class Logger {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly secrets: string[];
  private readonly now: () => number;

  constructor(options: LoggerOptions) {
    this.path = join(options.dir, options.file ?? "connector.log");
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.secrets = [...(options.secrets ?? [])];
    this.now = options.now ?? Date.now;
    mkdirSync(options.dir, { recursive: true });
  }

  get filePath(): string {
    return this.path;
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }

  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    const record: Record<string, unknown> = { ts: this.now(), level, event, ...fields };
    const line = redactText(JSON.stringify(record), this.secrets);
    try {
      appendCapped(this.path, line + "\n", this.maxBytes);
    } catch {
      // A logger must never take the daemon down (disk full, state dir removed at shutdown);
      // stderr still reaches launchd/journal for post-mortem.
      try {
        process.stderr.write(`[sig] log write failed: ${line}\n`);
      } catch {
        // nothing left to try
      }
    }
  }
}

/** Appends text to `path`, trimming the file to its newest half once it exceeds `maxBytes`. */
export function appendCapped(path: string, text: string, maxBytes: number): void {
  const existing = existsSync(path) ? statSync(path).size : 0;
  if (existing > maxBytes) {
    const tail = readFileSync(path, "utf8").slice(Math.floor(maxBytes / 2));
    const firstNewline = tail.indexOf("\n");
    writeFileSync(path, firstNewline === -1 ? tail : tail.slice(firstNewline + 1));
  }
  appendFileSync(path, text);
}

/** Last `lines` lines of a file (empty string when missing or empty). */
export function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8").trimEnd();
  if (content === "") return "";
  return content.split("\n").slice(-lines).join("\n");
}

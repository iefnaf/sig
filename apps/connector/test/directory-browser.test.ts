import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, parse } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { DIRECTORY_MAX_BYTES, DIRECTORY_MAX_ENTRIES, DirectoryListingMessageSchema, DirectoryListingSchema } from "@alexlikevibe/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browseDirectory } from "../src/directory-browser.ts";
import { ConnectorClient } from "../src/client.ts";
import { LocalStore } from "../src/store.ts";
import { tmpDir } from "./helpers.ts";

let dir: string;

beforeEach(() => {
  dir = realpathSync(tmpDir("sig-directory-browser"));
  vi.spyOn(os, "homedir").mockReturnValue(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("remote directory listings", () => {
  it("starts at the machine home, lists only directories, and can reveal hidden names", async () => {
    for (const name of ["zeta", "项目 with spaces", "alpha", ".private"]) mkdirSync(join(dir, name));
    writeFileSync(join(dir, "readme.txt"), "ordinary file");
    const visible = await browseDirectory({});
    expect(visible).toEqual({ ok: true, listing: {
      path: dir, home: dir, parent: dirname(dir), truncated: false,
      directories: ["alpha", "zeta", "项目 with spaces"].map((name) => ({ name, path: join(dir, name) })),
    } });
    const hidden = await browseDirectory({ path: "~", showHidden: true });
    expect(hidden.ok && hidden.listing.directories.map((item) => item.name)).toContain(".private");
  });

  it("expands home paths without shell interpretation and returns canonical parent paths", async () => {
    const name = "a $(echo unsafe)";
    mkdirSync(join(dir, name));
    symlinkSync(join(dir, name), join(dir, "linked"));
    expect(await browseDirectory({ path: `~/${name}` })).toMatchObject({ ok: true, listing: { path: join(dir, name), parent: dir, directories: [] } });
    expect(await browseDirectory({ path: join(dir, "linked") })).toMatchObject({ ok: true, listing: { path: join(dir, name), parent: dir } });
    expect(await browseDirectory({ path: parse(dir).root })).toMatchObject({ ok: true, listing: { parent: null } });
  });

  it("includes symlinks to directories and skips broken links and links to files", async () => {
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "file"), "x");
    symlinkSync(join(dir, "real"), join(dir, "linked"));
    symlinkSync(join(dir, "file"), join(dir, "file-link"));
    symlinkSync(join(dir, "missing"), join(dir, "broken"));
    const result = await browseDirectory({});
    expect(result.ok && result.listing.directories.map((item) => item.name)).toEqual(["linked", "real"]);
  });

  it("returns stable failures for missing, relative and non-directory paths", async () => {
    writeFileSync(join(dir, "file"), "x");
    expect(await browseDirectory({ path: "relative" })).toEqual({ ok: false, code: "invalid_directory" });
    expect(await browseDirectory({ path: join(dir, "missing") })).toEqual({ ok: false, code: "not_found" });
    expect(await browseDirectory({ path: join(dir, "file") })).toEqual({ ok: false, code: "invalid_directory" });
  });

  it.skipIf(process.getuid?.() === 0)("reports unreadable directories without exposing OS exception text", async () => {
    const locked = join(dir, "locked");
    mkdirSync(locked, { mode: 0o000 });
    try {
      expect(await browseDirectory({ path: locked })).toEqual({ ok: false, code: "forbidden" });
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("marks count- and byte-limited listings as truncated", async () => {
    for (let i = 0; i <= DIRECTORY_MAX_ENTRIES; i++) mkdirSync(join(dir, `folder-${i}`));
    const countLimited = await browseDirectory({});
    expect(countLimited).toMatchObject({ ok: true, listing: { truncated: true } });
    expect(countLimited.ok && countLimited.listing.directories).toHaveLength(DIRECTORY_MAX_ENTRIES);
    const long = join(dir, "long");
    mkdirSync(long);
    for (let i = 0; i < DIRECTORY_MAX_ENTRIES; i++) mkdirSync(join(long, `${String(i).padStart(3, "0")}${"x".repeat(240)}`));
    const byteLimited = await browseDirectory({ path: long });
    expect(byteLimited).toMatchObject({ ok: true, listing: { truncated: true } });
    if (!byteLimited.ok) throw new Error("listing failed");
    expect(byteLimited.listing.directories.length).toBeLessThan(DIRECTORY_MAX_ENTRIES);
    expect(Buffer.byteLength(JSON.stringify(byteLimited.listing))).toBeLessThanOrEqual(DIRECTORY_MAX_BYTES);
    expect(DirectoryListingSchema.safeParse(byteLimited.listing).success).toBe(true);
  });

  it("answers a socket request without creating a command row or registering a repository", async () => {
    mkdirSync(join(dir, "project"));
    const store = new LocalStore(join(dir, "state", "connector.sqlite"));
    const server: Server = createServer();
    const sockets = new WebSocketServer({ server });
    let client: ConnectorClient | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server has no port");
      store.saveCredentials({ serverUrl: `http://127.0.0.1:${address.port}`, deviceId: "test-device", token: "test-token" });
      const connected = new Promise<WebSocket>((resolve) => sockets.once("connection", resolve));
      client = new ConnectorClient({ store });
      client.start();
      const socket = await connected;
      const hello = await new Promise<unknown>((resolve) => socket.once("message", (message) => resolve(JSON.parse(String(message)))));
      expect(hello).toMatchObject({ capabilities: { directoryBrowse: true } });
      const reply = new Promise<unknown>((resolve) => socket.once("message", (message) => resolve(JSON.parse(String(message)))));
      socket.send(JSON.stringify({ t: "directory_list", id: "browse-1", path: "~" }));
      const parsed = DirectoryListingMessageSchema.parse(await reply);
      expect(parsed).toMatchObject({ t: "directory_listing", re: "browse-1", ok: true, listing: { path: dir } });
      expect(store.database.prepare("SELECT COUNT(*) AS n FROM command").get()).toMatchObject({ n: 0 });
      expect(store.listRepos()).toEqual([]);
    } finally {
      client?.stop();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });
});

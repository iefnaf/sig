import { HelloMessageSchema } from "@alexlikevibe/protocol";
import { describe, expect, it } from "vitest";
import { browseDirectory, buildHello, registerRepository, scriptForStartWorker, workerEvent } from "../src/protocol.ts";

describe("preview machine protocol", () => {
  it("sends a schema-valid hello with one repository", () => {
    const hello = buildHello({ deviceId: "dev_preview" }, "boot-preview", 3, []);

    expect(HelloMessageSchema.safeParse(hello).success).toBe(true);
    expect(hello.machine).toMatchObject({ name: "preview-machine" });
    expect(hello.capabilities).toEqual({ directoryBrowse: true });
    expect(hello.repos).toHaveLength(1);
  });

  it("browses the simulated home and hidden directories", () => {
    expect(browseDirectory({ path: "~", showHidden: false })).toEqual({
      ok: true,
      listing: {
        path: "/srv",
        home: "/srv",
        parent: "/",
        directories: [{ name: "repo-a", path: "/srv/repo-a" }],
        truncated: false,
      },
    });
    const repository = browseDirectory({ path: "/srv/repo-a", showHidden: true });
    expect(repository.ok).toBe(true);
    expect(repository.ok ? repository.listing.directories : []).toEqual([
      { name: ".git", path: "/srv/repo-a/.git" },
      { name: "src", path: "/srv/repo-a/src" },
    ]);
    expect(browseDirectory({ path: "/missing" })).toEqual({ ok: false, code: "not_found" });
  });

  it("registers the simulated Git root from a selected subdirectory", () => {
    expect(registerRepository("/srv/repo-a/src")).toEqual({
      ok: true,
      repo: {
        repoId: "/srv/repo-a",
        name: "repo-a",
        path: "/srv/repo-a",
        defaultBranch: "main",
        remote: "git@github.com:example/repo-a.git",
      },
    });
    expect(registerRepository("/srv/missing")).toEqual({ ok: false, code: "invalid_directory" });
  });

  it("builds worker event batches", () => {
    const event = workerEvent("worker-1", 1, "started", { sessionId: "worker-1" }, 123);

    expect(event.id).toBe("evt-worker-1-1");
    expect(event.batch[0]).toMatchObject({
      workerId: "worker-1",
      seq: 1,
      ts: 123,
      type: "started",
      sessionId: "worker-1",
    });
  });

  it("rejects start_worker without a worker id", () => {
    expect(scriptForStartWorker({})).toEqual({ ok: false, error: { code: "bad_worker_id" } });
  });
});

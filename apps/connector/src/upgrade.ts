// `sig upgrade` (issue #26): replace the npm package and restart the background service.
//
// The upgrade always ends with the service running the code from the global npm install, so
// an npx-launched `connect` becomes a durable global install on first upgrade. The process
// running `upgrade` is by definition the OLD code — it cannot write the new version's assets.
// The restarted daemon runs the new package and calls installAssets() at boot, which writes
// the new versioned extension/prompt files under ~/.sig/ (old versions stay on disk for
// sessions still referencing them).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultExec, type Exec, type ServiceInstaller } from "./service.ts";

export const PACKAGE_NAME = "@alexlikevibe/sig";

export interface UpgradeOptions {
  /** Explicit version; default "latest". */
  version?: string;
  currentVersion: string;
  exec?: Exec;
  /** Rebuilds the service for the newly installed entry path (new global root after upgrade). */
  getService: (entryPath: string) => ServiceInstaller | null;
  /** The bin wrapper this process is running from. */
  currentEntry: string;
  /** Reads the installed package's version (package.json) for the report. */
  readVersion?: (pkgRoot: string) => string | null;
}

export interface UpgradeResult {
  from: string;
  to: string;
  entryPath: string;
  /** True when a background service existed and was reinstalled/restarted. */
  serviceRestarted: boolean;
}

export function readPackageVersion(pkgRoot: string): string | null {
  const pkgPath = join(pkgRoot, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export async function runUpgrade(print: (line: string) => void, options: UpgradeOptions): Promise<UpgradeResult> {
  const exec = options.exec ?? defaultExec;
  const target = options.version ? `${PACKAGE_NAME}@${options.version}` : `${PACKAGE_NAME}@latest`;

  const rootRes = await exec("npm", ["root", "-g"]);
  if (rootRes.code !== 0) throw new Error(`npm root -g failed: ${rootRes.stderr.trim()}`);
  const npmRoot = rootRes.stdout.trim();
  if (!npmRoot) throw new Error("npm root -g returned an empty path");

  print(`installing ${target} globally...`);
  const install = await exec("npm", ["install", "-g", target]);
  if (install.code !== 0) {
    throw new Error(`npm install -g ${target} failed (${install.code}): ${install.stderr.trim()}`);
  }

  const pkgRoot = join(npmRoot, PACKAGE_NAME);
  const entryPath = join(pkgRoot, "bin", "sig.js");
  if (!existsSync(entryPath)) {
    throw new Error(`npm reported success but ${entryPath} is missing; install layout unexpected`);
  }
  const to = options.readVersion?.(pkgRoot) ?? readPackageVersion(pkgRoot);
  if (!to) throw new Error(`could not read the installed version from ${join(pkgRoot, "package.json")}`);

  // Restart the service against the (possibly new) entry path. install() rewrites the unit
  // and reloads it; the fresh daemon writes the new versioned assets on boot. A service the
  // user stopped stays stopped: reinstall the unit, then stop it again.
  let serviceRestarted = false;
  const installer = options.getService(entryPath);
  if (installer) {
    const status = await installer.status();
    if (status.installed) {
      await installer.install();
      if (status.running) {
        serviceRestarted = true;
        print("background service updated and restarted");
      } else {
        await installer.stop();
        print("background service updated (it was stopped; still stopped)");
      }
    } else {
      print("no installed background service to restart (it will run on next `connect`)");
    }
  } else {
    print("no background service support on this platform");
  }
  print(`upgraded ${options.currentVersion} → ${to}`);

  return { from: options.currentVersion, to, entryPath, serviceRestarted };
}

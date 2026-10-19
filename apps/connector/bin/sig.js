#!/usr/bin/env node
// sig bin wrapper (issue #26). This runs before any bundled code so the Node gate can
// print a readable error instead of a cryptic module crash: sig needs >= 22.18 for
// node:sqlite (unflagged since 22.13) and the toolchain baseline pinned in engines.
import { createRequire } from "node:module";

const MIN = [22, 18, 0];

function meetsMinimum(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (major > MIN[0]) return true;
  if (major < MIN[0]) return false;
  if (minor !== MIN[1]) return minor > MIN[1];
  return patch >= MIN[2];
}

function fail(message) {
  process.stderr.write(`sig: ${message}\n`);
  process.exit(1);
}

if (!meetsMinimum(process.versions.node)) {
  fail(
    `Node ${MIN.join(".")}+ is required (found ${process.versions.node}). ` +
      `Install a current Node from https://nodejs.org and retry.`,
  );
}

const require = createRequire(import.meta.url);
try {
  require("node:sqlite");
} catch (err) {
  fail(
    `this Node build cannot load node:sqlite (${err?.code ?? err?.message ?? "unknown error"}); ` +
      `use an official Node ${MIN.join(".")}+ build`,
  );
}

try {
  await import("../dist/cli.js");
} catch (err) {
  if (err && (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "ERR_UNSUPPORTED_DIR_IMPORT")) {
    fail("the sig bundle (dist/cli.js) is missing; reinstall the package");
  }
  throw err;
}

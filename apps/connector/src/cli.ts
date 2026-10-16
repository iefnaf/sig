#!/usr/bin/env node
// `npx @iefnaf/shepherd connect <url> <code>` (ADR-0001 decision 10): redeem a pairing code,
// then hold the connection open (reconnecting per protocol §3.3) like a long-running daemon.
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { ConnectorClient } from "./client.ts";
import { connect } from "./pairing.ts";
import { LocalStore } from "./store.ts";

const STATE_DIR = process.env.SHEPHERD_HOME ?? join(homedir(), ".shepherd");
const DB_PATH = join(STATE_DIR, "connector.sqlite");

function usage(): never {
  console.error("usage: shepherd connect <url> <code>");
  process.exit(2);
}

async function main(argv: string[]): Promise<void> {
  const [command, url, code] = argv;
  if (command !== "connect" || !url || !code) usage();

  const store = new LocalStore(DB_PATH);
  const machineName = process.env.SHEPHERD_MACHINE_NAME ?? hostname();
  const { deviceId } = await connect(url, code, machineName, { store });
  console.log(`paired as ${deviceId}; connecting...`);

  const client = new ConnectorClient({
    store,
    machineName,
    onWelcome: () => console.log(`${machineName} connected`),
    onClose: (closeCode, reason) => console.log(`connection closed: ${closeCode} ${reason}`),
  });
  client.start();
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

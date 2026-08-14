import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { configureEventWriter } from "../src/lib/events.js";
import { env } from "../src/lib/env.js";
import { ControlStore } from "../src/lib/store.js";
import { loadRulesFile } from "../src/rules.js";
import { createControlServer, listenControlServer } from "../src/server.js";

const databasePath = env.CONTROL_DB_PATH === ":memory:"
  ? env.CONTROL_DB_PATH
  : resolve(env.CONTROL_DB_PATH);
if (databasePath !== ":memory:") await mkdir(dirname(databasePath), { recursive: true });

const store = new ControlStore(databasePath);
configureEventWriter(store);
const server = createControlServer({
  store,
  defaults: {
    snapshotId: env.CONTROL_SNAPSHOT_ID,
    corpusVersion: env.CONTROL_CORPUS_VERSION,
    policyVersion: env.CONTROL_POLICY_VERSION,
    candidateIds: env.CONTROL_CANDIDATE_IDS,
  },
  loadRules: () => loadRulesFile(resolve(env.FORGE_RULES_PATH)),
  onError: (error) => console.error("[control] request failed", error),
});
const listening = await listenControlServer(server, env.CONTROL_PORT, "0.0.0.0");
console.log(`IntentGuard control API listening at ${listening.url}`);
console.log(`SQLite journal mode: ${store.getJournalMode()}`);

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await listening.close();
  store.close();
};

process.once("SIGINT", () => void close().catch((error: unknown) => {
  console.error("[control] shutdown failed", error);
  process.exitCode = 1;
}));
process.once("SIGTERM", () => void close().catch((error: unknown) => {
  console.error("[control] shutdown failed", error);
  process.exitCode = 1;
}));

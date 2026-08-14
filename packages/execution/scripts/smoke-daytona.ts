import { loadProvisionConfig } from "../src/lib/env.js";
import { liveRuntime } from "./live.js";

const config = loadProvisionConfig();
const candidateIds = Object.keys(config.repositories);
const snapshotId = process.argv[2];
if (snapshotId === undefined || snapshotId.length === 0) {
  throw new Error("Usage: pnpm smoke:daytona -- <snapshot-id>");
}
const runId = `smoke-daytona-${Date.now().toString(36)}`;
const runtime = liveRuntime();
try {
  const refs = await runtime.provision(runId, candidateIds, snapshotId);
  process.stdout.write(`${JSON.stringify({
    runId,
    target: config.daytona.target,
    resources: config.daytona.resources,
    sandboxes: refs,
  }, null, 2)}\n`);
} finally {
  await runtime.teardown(runId);
}

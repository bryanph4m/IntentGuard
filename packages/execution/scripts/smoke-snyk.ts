import { loadProvisionConfig } from "../src/lib/env.js";
import { liveRuntime } from "./live.js";

const config = loadProvisionConfig();
const candidateIds = Object.keys(config.repositories);
const snapshotId = process.argv[2];
if (snapshotId === undefined || snapshotId.length === 0) {
  throw new Error("Usage: pnpm smoke:snyk -- <snapshot-id>");
}
const runId = `smoke-snyk-${Date.now().toString(36)}`;
const runtime = liveRuntime();
try {
  const refs = await runtime.provision(runId, candidateIds, snapshotId);
  const scans = await Promise.all(
    refs.filter((ref) => ref.candidateId !== "legacy").map((ref) => runtime.scan(runId, ref)),
  );
  process.stdout.write(`${JSON.stringify(scans, null, 2)}\n`);
  if (scans.some((scan) => scan.status === "ERROR")) throw new Error("At least one Snyk scan returned ERROR.");
} finally {
  await runtime.teardown(runId);
}

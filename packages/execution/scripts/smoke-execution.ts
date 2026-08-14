import assert from "node:assert/strict";
import type {
  CandidateId,
  GateResult,
  RunEvent,
  ScanResult,
  Verdict,
} from "@intentguard/contracts";
import type { ProvisionConfig, RocketRideConfig } from "../src/lib/env.js";
import type {
  DaytonaPort,
  NarratorPort,
  PendingExecutionEvent,
  RuntimeDependencies,
  SandboxPort,
} from "../src/lib/ports.js";
import { ExecutionRuntime } from "../src/runtime.js";
import { parseSnykResult } from "../src/snyk.js";

const trace: string[] = [];

class FakeSandbox implements SandboxPort {
  readonly createdAt = "2026-08-14T12:00:00.000Z";
  readonly deleted: string[] = [];

  constructor(readonly id: string, private readonly snykOutput: string, private readonly snykExit = 0) {}

  async clone(_url: string, _path: string, commitSha: string): Promise<void> {
    trace.push(`${this.id}:clone:${commitSha}`);
  }

  async resize(resources: { cpu: number; memory: number; disk: number }): Promise<void> {
    trace.push(`${this.id}:resize:${JSON.stringify(resources)}`);
  }

  async execute(command: string, _cwd: string, env: Record<string, string>): Promise<{ exitCode: number; output: string }> {
    trace.push(`${this.id}:execute:${command}:${Object.keys(env).join(",")}`);
    if (command.includes("snyk")) return { exitCode: this.snykExit, output: this.snykOutput };
    return { exitCode: 0, output: "installed" };
  }

  async start(): Promise<void> {
    trace.push(`${this.id}:start`);
  }

  async signedPreviewUrl(port: number): Promise<string> {
    return `https://${this.id}.example.test:${String(port)}/?token=signed`;
  }

  async delete(): Promise<void> {
    this.deleted.push(this.id);
    trace.push(`${this.id}:delete`);
  }
}

class FakeDaytona implements DaytonaPort {
  readonly sandboxes = new Map<string, FakeSandbox>();

  async create(input: { labels: Record<string, string> }): Promise<SandboxPort> {
    const candidateId = input.labels.candidateId ?? "unknown";
    const output = candidateId === "A"
      ? JSON.stringify({ vulnerabilities: [{
        id: "SNYK-CMDI-001",
        severity: "critical",
        title: "Command injection",
        file: "server.ts",
        line: 41,
      }] })
      : JSON.stringify({ vulnerabilities: [] });
    const sandbox = new FakeSandbox(`sb-${candidateId}`, output, candidateId === "A" ? 1 : 0);
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async *list(): AsyncIterable<SandboxPort> {
    yield* this.sandboxes.values();
  }
}

class FakeNarrator implements NarratorPort {
  async narrate(verdict: Verdict, gates: GateResult[]): Promise<string> {
    assert.equal(verdict.outcome, "RECOMMEND");
    assert.equal(gates.length, 1);
    return "Candidate C is recommended because every blocking gate passed.";
  }

  async close(): Promise<void> {
    trace.push("narrator:close");
  }
}

const provisionConfig: ProvisionConfig = {
  daytona: {
    apiKey: "test",
    apiUrl: "https://daytona.example.test/api",
    target: "us",
    resources: { cpu: 2, memory: 4, disk: 20 },
    ttlMinutes: 45,
    createTimeoutSeconds: 30,
    commandTimeoutSeconds: 30,
    previewTtlSeconds: 3600,
  },
  repositories: {
    legacy: { url: "https://example.test/legacy.git", commitSha: "1111111111111111111111111111111111111111" },
    A: { url: "https://example.test/a.git", commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    C: { url: "https://example.test/c.git", commitSha: "cccccccccccccccccccccccccccccccccccccccc" },
  },
  repositoryDir: "/workspace/app",
  installCommand: "pnpm install --frozen-lockfile",
  startCommand: "pnpm start",
  appPort: 3000,
  healthPath: "/health",
  healthTimeoutSeconds: 2,
  healthPollMs: 1,
  networkAllowList: "example.test",
  snyk: { token: "secret", cliPath: "snyk", timeoutSeconds: 30 },
};

const rocketRideConfig: RocketRideConfig = {
  ROCKETRIDE_API_KEY: "test",
  ROCKETRIDE_URI: "https://rocketride.example.test",
  ROCKETRIDE_PIPELINE_PATH: "narrate.pipe",
  ROCKETRIDE_REQUEST_TIMEOUT_MS: 1000,
  ROCKETRIDE_PIPELINE_TTL_SECONDS: 60,
};

const events: Array<{ runId: string; event: PendingExecutionEvent }> = [];
const daytona = new FakeDaytona();
const dependencies: RuntimeDependencies = {
  loadProvisionConfig: () => provisionConfig,
  loadDaytonaConfig: () => provisionConfig.daytona,
  createDaytona: () => daytona,
  loadRocketRideConfig: () => rocketRideConfig,
  createNarrator: () => new FakeNarrator(),
  emitEvent: (runId, event) => events.push({ runId, event }),
  fetch: async () => new Response("ok", { status: 200 }),
  now: () => new Date("2026-08-14T12:00:00.000Z"),
  sleep: async () => undefined,
};

const runtime = new ExecutionRuntime(dependencies);
const refs = await runtime.provision("run-smoke", ["legacy", "A", "C"], "snap-1");
assert.deepEqual(refs.map((ref) => ref.candidateId), ["legacy", "A", "C"]);
assert.ok(refs.every((ref) => ref.snapshotId === "snap-1" && ref.previewUrl.includes("token=signed")));
for (const candidateId of ["A", "C"]) {
  const scanIndex = trace.findIndex((entry) => entry.startsWith(`sb-${candidateId}:execute:snyk`));
  const startIndex = trace.findIndex((entry) => entry === `sb-${candidateId}:start`);
  assert.ok(scanIndex >= 0 && scanIndex < startIndex, `${candidateId} must be scanned before app start`);
}
const aRef = refs.find((ref) => ref.candidateId === "A");
assert.ok(aRef !== undefined);
const scan = await runtime.scan("run-smoke", aRef);
assert.equal(scan.status, "FINDINGS");
assert.equal(scan.findings[0]?.id, "SNYK-CMDI-001");
const verdict: Verdict = {
  outcome: "RECOMMEND",
  recommended: "C",
  perCandidate: [{ candidateId: "C", eligible: true, reasons: [] }],
  policyVersion: "policy-1",
};
const gates: GateResult[] = [{
  candidateId: "C",
  key: "security",
  category: "security",
  status: "PASS",
  detail: "clean",
}];
const narration = await runtime.narrate("run-smoke", verdict, gates);
assert.match(narration, /Candidate C/);
await runtime.teardown("run-smoke");
await runtime.teardown("run-smoke");
assert.ok([...daytona.sandboxes.values()].every((sandbox) => sandbox.deleted.length === 1));
assert.equal(events.filter(({ event }) => event.type === "TORN_DOWN").length, 1);

const clean = parseSnykResult("C", { exitCode: 0, output: JSON.stringify({ vulnerabilities: [] }) });
const malformed = parseSnykResult("C", { exitCode: 0, output: "not json" });
const crashed = parseSnykResult("C", { exitCode: 2, output: JSON.stringify({ error: "offline" }) });
assert.equal(clean.status, "CLEAN");
assert.equal(malformed.status, "ERROR");
assert.equal(crashed.status, "ERROR");
assert.ok(events.some(({ event }) => event.type === "SANDBOX_CREATED" && event.source === "daytona"));
assert.ok(events.some(({ event }) => event.type === "SCAN_COMPLETE" && event.source === "snyk"));
assert.ok(events.some(({ event }) => event.type === "NARRATED" && event.source === "rocketride"));

const degradedEvents: Array<Omit<RunEvent, "seq" | "ts">> = [];
const degradedRuntime = new ExecutionRuntime({
  ...dependencies,
  createNarrator: () => { throw new Error("service unavailable"); },
  emitEvent: (_runId, event) => degradedEvents.push(event),
});
const degraded = await degradedRuntime.narrate("run-degraded", verdict, gates);
assert.match(degraded, /^Narration unavailable: service unavailable$/);
assert.equal(degradedEvents[0]?.type, "NARRATED");

const statuses: ScanResult["status"][] = [clean.status, malformed.status, crashed.status, scan.status];
process.stdout.write(`execution smoke passed: ${String(refs.length)} sandboxes, scans ${statuses.join(", ")}\n`);

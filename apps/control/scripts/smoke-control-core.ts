import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CandidateId,
  CorpusInput,
  RawResult,
  Rule,
  RunEvent,
  SandboxRef,
  ScanResult,
} from "@intentguard/contracts";
import { approvalIsValid } from "../src/approval.js";
import { compare } from "../src/comparison.js";
import { configureEventWriter, emitEvent, resetEventWriter } from "../src/lib/events.js";
import { ControlStore } from "../src/lib/store.js";
import { decide } from "../src/policy.js";
import { loadRulesFile } from "../src/rules.js";
import { createControlServer, listenControlServer } from "../src/server.js";
import {
  evaluateRun,
  runWorkerLoop,
  teardownApprovedRun,
  type WorkerDependencies,
} from "../src/worker.js";

const rules: Rule[] = [{
  id: "REQ-014",
  title: "Approval boundary",
  behavior: "Refund approval must match the legacy service at the locked boundary.",
  boundaries: ["500.49"],
  blocking: true,
}];

const corpus: CorpusInput[] = [{
  id: "IN-0001",
  ruleId: "REQ-014",
  method: "POST",
  path: "/refunds/approve",
  payload: { amount: "500.49" },
}];

function sandbox(runId: string, candidateId: CandidateId): SandboxRef {
  return {
    candidateId,
    sandboxId: `sandbox-${runId}-${candidateId}`,
    snapshotId: "snapshot-smoke",
    commitSha: `commit-${candidateId}`,
    previewUrl: `http://${candidateId}.smoke.local`,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

function replay(candidateId: CandidateId): RawResult[] {
  return [{
    candidateId,
    inputId: "IN-0001",
    status: 200,
    body: { approved: true, audit: { rule: "REQ-014" } },
    latencyMs: candidateId === "A" ? 8 : 10,
  }];
}

function scan(candidateId: CandidateId): ScanResult {
  return candidateId === "B"
    ? {
        candidateId,
        status: "FINDINGS",
        findings: [{
          id: "SNYK-CMDI-001",
          severity: "critical",
          title: "Shell command injection",
          file: "server.py",
          line: 233,
        }],
        raw: { tool: "smoke" },
      }
    : { candidateId, status: "CLEAN", findings: [], raw: { tool: "smoke" } };
}

function buildDependencies(store: ControlStore): WorkerDependencies {
  return {
    loadRules: async () => rules,
    generateCorpus: () => corpus,
    provision: async (runId, candidateIds) => candidateIds.map((candidateId) => {
      const reference = sandbox(runId, candidateId);
      emitEvent(runId, {
        source: "daytona",
        type: "SANDBOX_CREATED",
        candidateId,
        message: `Created ${reference.sandboxId}.`,
        payload: reference,
      });
      return reference;
    }),
    verify: async (runId, reference) => {
      emitEvent(runId, {
        source: "daytona",
        type: "APP_HEALTHY",
        candidateId: reference.candidateId,
        message: `${reference.candidateId} is healthy.`,
        payload: { previewUrl: reference.previewUrl },
      });
      return {
        build: { passed: true, detail: "build passed" },
        health: { passed: true, detail: "health check passed" },
      };
    },
    replay: async (runId, _previewUrl, _corpus, candidateId) => {
      const results = replay(candidateId);
      emitEvent(runId, {
        source: "rocketride",
        type: "CORPUS_REPLAYED",
        candidateId,
        message: `Replayed ${String(results.length)} input for ${candidateId}.`,
        payload: { results },
      });
      return results;
    },
    scan: async (runId, reference) => {
      const result = scan(reference.candidateId);
      emitEvent(runId, {
        source: "snyk",
        type: "SCAN_COMPLETE",
        candidateId: reference.candidateId,
        message: `Scan ${result.status} for ${reference.candidateId}.`,
        payload: result,
      });
      return result;
    },
    narrate: async (runId, verdict) => {
      const narration = `Candidate ${verdict.recommended ?? "none"} is the stored recommendation.`;
      emitEvent(runId, {
        source: "rocketride",
        type: "NARRATED",
        message: narration,
        payload: { narration },
      });
      return narration;
    },
    teardown: async (runId) => {
      emitEvent(runId, {
        source: "daytona",
        type: "TORN_DOWN",
        message: "Released all run sandboxes.",
        payload: { sandboxCount: store.getCandidates(runId).filter((item) => item.sandbox !== null).length },
      });
    },
  };
}

function eventData(stream: string): RunEvent[] {
  return stream
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as RunEvent);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "intentguard-control-"));
const store = new ControlStore(join(temporaryDirectory, "control.sqlite"));
configureEventWriter(store);

try {
  assert.equal(store.getJournalMode().toLowerCase(), "wal");

  const rulesPath = join(temporaryDirectory, "rules.json");
  writeFileSync(rulesPath, JSON.stringify(rules), "utf8");
  assert.deepEqual(await loadRulesFile(rulesPath), rules);
  writeFileSync(rulesPath, "not-json", "utf8");
  await assert.rejects(loadRulesFile(rulesPath), /not valid JSON/u);

  const legacy = replay("legacy");
  const divergent = replay("A").map((result) => ({
    ...result,
    body: { audit: { rule: "REQ-014" }, approved: false },
  }));
  const compared = compare(legacy, divergent, rules, corpus);
  assert.equal(compared.length, 1);
  assert.equal(compared[0]?.status, "FAIL");
  assert.match(compared[0]?.detail ?? "", /legacy approved=true, candidate approved=false/u);
  const statusMismatch = compare(
    legacy,
    replay("A").map((result) => ({ ...result, status: 403 })),
    rules,
    corpus,
  );
  assert.match(statusMismatch[0]?.detail ?? "", /legacy status=200, candidate status=403/u);

  const inconclusive = decide([], [], {
    candidateIds: ["A"],
    environment: { consistent: false, detail: "snapshot mismatch" },
  });
  assert.equal(inconclusive.outcome, "INCONCLUSIVE");
  const missingReadiness = decide([], [scan("A")], { candidateIds: ["A"], rules });
  assert.equal(missingReadiness.outcome, "BLOCKED");
  assert.match(missingReadiness.perCandidate[0]?.reasons.join("; ") ?? "", /build: gate result missing/u);
  const passingGates = (candidateId: CandidateId) => ([
    { candidateId, key: "build", category: "build" as const, status: "PASS" as const, detail: "ok" },
    { candidateId, key: "health", category: "health" as const, status: "PASS" as const, detail: "ok" },
    {
      candidateId,
      key: "behavior.REQ-014",
      category: "behavior" as const,
      ruleId: "REQ-014",
      inputId: "IN-0001",
      status: "PASS" as const,
      detail: "matched",
    },
  ]);
  const tied = decide(
    [...passingGates("A"), ...passingGates("B")],
    [scan("A"), { ...scan("A"), candidateId: "B" }],
    {
      candidateIds: ["A", "B"],
      rules,
      rawResults: [...replay("A"), ...replay("B")].map((result) => ({ ...result, latencyMs: 10 })),
      commitOrder: ["B", "A"],
    },
  );
  assert.equal(tied.recommended, "B");
  assert.match(tied.perCandidate[0]?.reasons.join("; ") ?? "", /tie-break/u);
  const scannerError = decide(passingGates("A"), [{
    candidateId: "A",
    status: "ERROR",
    findings: [],
    raw: { error: "scanner unavailable" },
  }], { candidateIds: ["A"], rules });
  assert.equal(scannerError.outcome, "BLOCKED");

  const dependencies = buildDependencies(store);
  const serverErrors: unknown[] = [];
  const server = createControlServer({
    store,
    defaults: {
      snapshotId: "snapshot-smoke",
      corpusVersion: "corpus-smoke",
      policyVersion: "policy-smoke",
      candidateIds: ["legacy", "A", "B"],
    },
    loadRules: async () => rules,
    afterApproval: async (runId) => teardownApprovedRun(runId, store, dependencies),
    onError: (error) => serverErrors.push(error),
  });
  const listening = await listenControlServer(server, 0);
  let listeningClosed = false;
  try {
    const health = await fetch(`${listening.url}/health`);
    assert.equal(health.status, 200);

    const created = await fetch(`${listening.url}/api/runs`, { method: "POST" });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { runId: string };
    assert.match(createdBody.runId, /^RUN-/u);

    const verdict = await evaluateRun(createdBody.runId, store, dependencies, {
      blockingSeverity: "high",
    });
    assert.equal(verdict.outcome, "RECOMMEND");
    assert.equal(verdict.recommended, "A");
    assert.equal(store.requireRun(createdBody.runId).state, "AWAITING_APPROVAL");
    assert.equal(store.listEvents(createdBody.runId).some((event) => event.type === "TORN_DOWN"), false);

    const approval = await fetch(`${listening.url}/api/runs/${createdBody.runId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "Bryan", comment: "Evidence reviewed." }),
    });
    assert.equal(approval.status, 200);
    const approvalBody = await approval.json() as { digest: string };
    assert.match(approvalBody.digest, /^[0-9a-f]{64}$/u);
    assert.equal(store.requireRun(createdBody.runId).state, "APPROVED");
    assert.equal(approvalIsValid(createdBody.runId, store), true);

    const duplicateApproval = await fetch(`${listening.url}/api/runs/${createdBody.runId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "Bryan", comment: "Duplicate." }),
    });
    assert.equal(duplicateApproval.status, 409);
    const invalidApproval = await fetch(`${listening.url}/api/runs/${createdBody.runId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "Bryan", comment: "", extra: true }),
    });
    assert.equal(invalidApproval.status, 400);
    assert.equal((await fetch(`${listening.url}/api/runs/RUN-does-not-exist`)).status, 404);

    const streamResponse = await fetch(`${listening.url}/api/runs/${createdBody.runId}/events`);
    assert.equal(streamResponse.status, 200);
    const events = eventData(await streamResponse.text());
    assert.ok(events.length > 10);
    assert.ok(events.every((event, index) => event.seq === index + 1));
    assert.equal(events.filter((event) => event.type === "VERDICT_READY").length, 1);
    assert.equal(events.at(-2)?.type, "APPROVED");
    assert.equal(events.at(-1)?.type, "TORN_DOWN");

    const resumedResponse = await fetch(`${listening.url}/api/runs/${createdBody.runId}/events`, {
      headers: { "last-event-id": String(events.length - 2) },
    });
    const resumed = eventData(await resumedResponse.text());
    assert.deepEqual(resumed.map((event) => event.type), ["APPROVED", "TORN_DOWN"]);

    const jsonReport = await fetch(`${listening.url}/api/runs/${createdBody.runId}/report.json`);
    assert.equal(jsonReport.status, 200);
    const reportBody = await jsonReport.json() as { approvalValid: boolean; currentDigest: string };
    assert.equal(reportBody.approvalValid, true);
    assert.equal(reportBody.currentDigest, approvalBody.digest);

    const markdownReport = await fetch(`${listening.url}/api/runs/${createdBody.runId}/report.md`);
    assert.equal(markdownReport.status, 200);
    assert.match(await markdownReport.text(), /Verdict: \*\*RECOMMEND\*\* candidate \*\*A\*\*/u);

    const failedRunId = "RUN-failure-smoke";
    store.createRun({
      runId: failedRunId,
      snapshotId: "snapshot-smoke",
      corpusVersion: "corpus-smoke",
      policyVersion: "policy-smoke",
      candidateIds: ["legacy", "A"],
    });
    emitEvent(failedRunId, {
      source: "control",
      type: "RUN_QUEUED",
      message: "Failure-path run queued.",
    });
    await assert.rejects(
      evaluateRun(failedRunId, store, {
        ...dependencies,
        loadRules: async () => { throw new Error("Forge artifact unavailable"); },
      }),
      /Forge artifact unavailable/u,
    );
    assert.equal(store.requireRun(failedRunId).state, "BLOCKED");
    assert.equal(store.getVerdict(failedRunId)?.outcome, "INCONCLUSIVE");
    assert.equal(store.listEvents(failedRunId).at(-1)?.type, "TORN_DOWN");
    assert.equal(serverErrors.length, 0);

    const degradedRunId = "RUN-degraded-smoke";
    store.createRun({
      runId: degradedRunId,
      snapshotId: "snapshot-smoke",
      corpusVersion: "corpus-smoke",
      policyVersion: "policy-smoke",
      candidateIds: ["legacy", "A"],
    });
    emitEvent(degradedRunId, {
      source: "control",
      type: "RUN_QUEUED",
      message: "Degraded-path run queued.",
    });
    const degradedVerdict = await evaluateRun(degradedRunId, store, {
      ...dependencies,
      scan: async () => { throw new Error("scanner transport failed"); },
    });
    assert.equal(degradedVerdict.outcome, "INCONCLUSIVE");
    assert.equal(store.requireRun(degradedRunId).state, "BLOCKED");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await runWorkerLoop(store, dependencies, controller.signal, (runId, error) => {
      throw new Error(`Unexpected worker error for ${runId}.`, { cause: error });
    }, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);

    store.saveGates(createdBody.runId, [{
      candidateId: "A",
      key: "behavior.REQ-014",
      category: "behavior",
      ruleId: "REQ-014",
      inputId: "IN-0001",
      status: "FAIL",
      detail: "evidence changed after approval",
    }]);
    assert.equal(approvalIsValid(createdBody.runId, store), false);

    const openRun = await fetch(`${listening.url}/api/runs`, { method: "POST" });
    const openRunBody = await openRun.json() as { runId: string };
    const openStream = await fetch(`${listening.url}/api/runs/${openRunBody.runId}/events`);
    const drained = openStream.text().catch((error: unknown) => String(error));
    await listening.close();
    listeningClosed = true;
    await drained;
  } finally {
    if (!listeningClosed) await listening.close();
  }

  console.log("control core smoke passed: persistence, worker, API, SSE, approval, reports, failure recovery");
} finally {
  resetEventWriter();
  store.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

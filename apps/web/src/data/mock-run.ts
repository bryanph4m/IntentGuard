import type {
  ApprovalRecord,
  CandidateId,
  GateResult,
  LedgerRow,
  LedgerValue,
  ModernCandidateId,
  RunEvent,
  RunEventType,
  SandboxRecord,
  ScanResult,
  Verdict,
} from "../types";

const SNAPSHOT_ID = "snap_ig_py27_20260813_01";
const BASE_TIME = Date.parse("2026-08-14T04:25:10.000Z");

const resources = {
  cpu: "2 vCPU",
  memory: "4 GB",
  disk: "8 GB",
  region: "us-west-2",
} as const;

export const mockSandboxes: readonly SandboxRecord[] = [
  {
    candidateId: "legacy",
    sandboxId: "sbx_ig_legacy_7f31",
    snapshotId: SNAPSHOT_ID,
    commitSha: "6b7e9d2a418f",
    previewUrl: "https://legacy-7f31.preview.internal",
    createdAt: "2026-08-14T04:25:12.816Z",
    resources,
  },
  {
    candidateId: "A",
    sandboxId: "sbx_ig_cand_a_19c4",
    snapshotId: SNAPSHOT_ID,
    commitSha: "c4a1811d2e93",
    previewUrl: "https://candidate-a-19c4.preview.internal",
    createdAt: "2026-08-14T04:25:13.422Z",
    resources,
  },
  {
    candidateId: "B",
    sandboxId: "sbx_ig_cand_b_a880",
    snapshotId: SNAPSHOT_ID,
    commitSha: "aa03857b941c",
    previewUrl: "https://candidate-b-a880.preview.internal",
    createdAt: "2026-08-14T04:25:14.105Z",
    resources,
  },
  {
    candidateId: "C",
    sandboxId: "sbx_ig_cand_c_e242",
    snapshotId: SNAPSHOT_ID,
    commitSha: "4de72f6c83a1",
    previewUrl: "https://candidate-c-e242.preview.internal",
    createdAt: "2026-08-14T04:25:14.692Z",
    resources,
  },
];

function quiet(text: string): LedgerValue {
  return { summary: text, parts: [{ text, different: false }] };
}

function changed(...parts: Array<[string, boolean]>): LedgerValue {
  return {
    summary: parts.map(([text]) => text).join(""),
    parts: parts.map(([text, different]) => ({ text, different })),
  };
}

interface EvidenceFixture {
  inputId: string;
  ruleId: string;
  probe: string;
  legacy: LedgerValue;
  candidate: LedgerValue;
  status: "MATCH" | "DIVERGENT";
  note: string;
}

const commonEvidence: readonly Omit<EvidenceFixture, "candidate" | "status" | "note">[] = [
  { inputId: "IN-0007", ruleId: "REQ-001", probe: "$499.99 · clerk", legacy: quiet("200 APPROVED · $499.99") },
  { inputId: "IN-0012", ruleId: "REQ-014", probe: "$500.00 · clerk", legacy: quiet("200 APPROVED · $500.00") },
  { inputId: "IN-0013", ruleId: "REQ-014", probe: "$500.49 · clerk", legacy: quiet("200 APPROVED · $500.49") },
  { inputId: "IN-0014", ruleId: "REQ-014", probe: "$500.99 · clerk", legacy: quiet("200 APPROVED · $500.99") },
  { inputId: "IN-0015", ruleId: "REQ-001", probe: "$501.00 · clerk", legacy: quiet("403 FINANCE_ROLE_REQUIRED") },
  { inputId: "IN-0021", ruleId: "REQ-022", probe: "$2,400 · 2026-08-31", legacy: quiet("200 APPROVED · MONTH_END") },
  { inputId: "IN-0028", ruleId: "REQ-031", probe: "−$50.00 · clerk", legacy: quiet("200 APPROVED · $0.00") },
];

function matchingRows(candidateId: "B" | "C"): LedgerRow[] {
  return commonEvidence.map((fixture, index) => ({
    id: `${candidateId}-${fixture.inputId}`,
    order: index + 1,
    candidateId,
    inputId: fixture.inputId,
    ruleId: fixture.ruleId,
    probe: fixture.probe,
    legacy: fixture.legacy,
    candidate: quiet(fixture.legacy.summary),
    status: "MATCH",
    note: "Observed response matches the legacy replay.",
  }));
}

const candidateARows: LedgerRow[] = [
  {
    id: "A-IN-0007",
    order: 1,
    candidateId: "A",
    inputId: "IN-0007",
    ruleId: "REQ-001",
    probe: "$499.99 · clerk",
    legacy: quiet("200 APPROVED · $499.99"),
    candidate: quiet("200 APPROVED · $499.99"),
    status: "MATCH",
    note: "Observed response matches the legacy replay.",
  },
  ...["500.00", "500.49", "500.99"].map((amount, index): LedgerRow => ({
    id: `A-IN-001${index + 2}`,
    order: index + 2,
    candidateId: "A",
    inputId: `IN-001${index + 2}`,
    ruleId: "REQ-014",
    probe: `$${amount} · clerk`,
    legacy: changed(["200 ", false], ["APPROVED", true], [` · $${amount}`, false]),
    candidate: changed(["403 ", false], ["FINANCE_ROLE_REQUIRED", true]),
    status: "DIVERGENT",
    note: `Candidate requires finance_admin at $${amount}; legacy approves after integer truncation.`,
  })),
  {
    id: "A-IN-0015",
    order: 5,
    candidateId: "A",
    inputId: "IN-0015",
    ruleId: "REQ-001",
    probe: "$501.00 · clerk",
    legacy: quiet("403 FINANCE_ROLE_REQUIRED"),
    candidate: quiet("403 FINANCE_ROLE_REQUIRED"),
    status: "MATCH",
    note: "Observed response matches the legacy replay.",
  },
  {
    id: "A-IN-0021",
    order: 6,
    candidateId: "A",
    inputId: "IN-0021",
    ruleId: "REQ-022",
    probe: "$2,400 · 2026-08-31",
    legacy: quiet("200 APPROVED · MONTH_END"),
    candidate: quiet("200 APPROVED · MONTH_END"),
    status: "MATCH",
    note: "Observed response matches the legacy replay.",
  },
  {
    id: "A-IN-0028",
    order: 7,
    candidateId: "A",
    inputId: "IN-0028",
    ruleId: "REQ-031",
    probe: "−$50.00 · clerk",
    legacy: changed(["200 APPROVED · ", false], ["$0.00", true]),
    candidate: changed(["400 ", false], ["INVALID_AMOUNT", true]),
    status: "DIVERGENT",
    note: "Candidate rejects the negative amount; legacy clamps it to zero and approves.",
  },
];

export const mockLedgerRows: readonly LedgerRow[] = [
  ...candidateARows,
  ...matchingRows("B"),
  ...matchingRows("C"),
];

const scans: readonly ScanResult[] = [
  { candidateId: "A", status: "CLEAN", findings: [] },
  {
    candidateId: "B",
    status: "FINDINGS",
    findings: [
      {
        id: "SNYK-JS-NODETLS-1097421",
        severity: "critical",
        title: "TLS certificate verification disabled",
        file: "src/legacy-client.ts",
        line: 47,
      },
    ],
  },
  { candidateId: "C", status: "CLEAN", findings: [] },
];

export const mockVerdict: Verdict = {
  outcome: "RECOMMEND",
  recommended: "C",
  perCandidate: [
    { candidateId: "A", eligible: false, reasons: ["behavior.REQ-014", "behavior.REQ-031"] },
    { candidateId: "B", eligible: false, reasons: ["security.SNYK-JS-NODETLS-1097421"] },
    { candidateId: "C", eligible: true, reasons: [] },
  ],
  policyVersion: "ig-policy/2026.08.13-rc3",
};

function gateFor(row: LedgerRow): GateResult {
  const gate: GateResult = {
    candidateId: row.candidateId,
    key: `behavior.${row.ruleId}.${row.inputId}.${row.candidateId}`,
    category: "behavior",
    ruleId: row.ruleId,
    status: row.status === "MATCH" ? "PASS" : "FAIL",
    detail: row.note,
    inputId: row.inputId,
  };
  return gate;
}

function timestamp(seq: number): string {
  return new Date(BASE_TIME + seq * 875).toISOString();
}

export function createMockEvents(runId: string): RunEvent[] {
  const events: RunEvent[] = [];
  let seq = 0;

  const add = (
    source: RunEvent["source"],
    type: RunEventType,
    message: string,
    candidateId?: CandidateId,
    payload?: unknown,
  ) => {
    seq += 1;
    const event: RunEvent = { seq, ts: timestamp(seq), source, type, message };
    if (candidateId !== undefined) event.candidateId = candidateId;
    if (payload !== undefined) event.payload = payload;
    events.push(event);
  };

  add("control", "RUN_QUEUED", `${runId} queued for three candidates.`, undefined, { kind: "run", runId });
  add("forge", "RULES_LOCKED", "Five recovered rules locked at forge/rules.json.", undefined, {
    kind: "rules",
    count: 5,
    rulesDigest: "sha256:47f15a3d8c27",
  });

  for (const sandbox of mockSandboxes) {
    add("daytona", "SANDBOX_CREATED", `${sandbox.candidateId} sandbox allocated from the shared snapshot.`, sandbox.candidateId, {
      kind: "sandbox",
      sandbox,
    });
  }

  for (const sandbox of mockSandboxes) {
    add("forge", "SOURCE_READY", `${sandbox.candidateId} source pinned at ${sandbox.commitSha}.`, sandbox.candidateId, {
      kind: "source",
      commitSha: sandbox.commitSha,
    });
  }

  for (const sandbox of mockSandboxes) {
    add("daytona", "APP_HEALTHY", `${sandbox.candidateId} returned 200 from /health.`, sandbox.candidateId, {
      kind: "health",
      path: "/health",
      status: 200,
      latencyMs: sandbox.candidateId === "legacy" ? 31 : 18,
    });
  }

  for (const sandbox of mockSandboxes) {
    add("control", "CORPUS_REPLAYED", `Thirty-one boundary inputs replayed against ${sandbox.candidateId}.`, sandbox.candidateId, {
      kind: "replay",
      inputCount: 31,
      durationMs: sandbox.candidateId === "legacy" ? 1384 : 946,
    });
  }

  for (const candidateId of ["A", "B", "C"] as const) {
    const rows = mockLedgerRows.filter((row) => row.candidateId === candidateId);
    for (const row of rows) {
      if (row.status === "DIVERGENT") {
        add("control", "DIVERGENCE_FOUND", `${row.ruleId} diverged on ${row.inputId}: ${row.note}`, candidateId, {
          kind: "divergence",
          rowId: row.id,
          ruleId: row.ruleId,
          inputId: row.inputId,
        });
      }
      add("control", "GATE_RESULT", `${row.ruleId} / ${row.inputId}: ${row.status}.`, candidateId, {
        kind: "ledger",
        row,
        gate: gateFor(row),
      });
    }

    const scan = scans.find((item) => item.candidateId === candidateId);
    if (scan !== undefined) {
      const message = scan.status === "CLEAN"
        ? `${candidateId} security scan completed with no findings.`
        : `${candidateId} security scan found one critical issue.`;
      add("snyk", "SCAN_COMPLETE", message, candidateId, { kind: "scan", scan });
    }
  }

  add("control", "VERDICT_READY", "Candidate C is the only candidate eligible under the locked policy.", undefined, {
    kind: "verdict",
    verdict: mockVerdict,
  });
  add("rocketride", "NARRATED", "Candidate C preserves all recovered behaviors and completed a clean security scan. Candidate A changes two required legacy behaviors. Candidate B preserves behavior but is blocked by a critical TLS finding.", undefined, {
    kind: "narration",
    narration: "Candidate C preserves all recovered behaviors and completed a clean security scan. Candidate A changes two required legacy behaviors. Candidate B preserves behavior but is blocked by a critical TLS finding.",
  });

  for (const sandbox of mockSandboxes) {
    add("daytona", "TORN_DOWN", `${sandbox.candidateId} sandbox released.`, sandbox.candidateId, {
      kind: "teardown",
      sandboxId: sandbox.sandboxId,
    });
  }

  return events;
}

export function createMockApproval(reviewer: string, comment: string): ApprovalRecord {
  return {
    digest: "sha256:8c14a77fa61bd9953874ea12c271d27e6541f718ab714ced07479338d302f062",
    policyVersion: mockVerdict.policyVersion,
    sandboxIds: mockSandboxes.map((sandbox) => sandbox.sandboxId),
    reviewer,
    comment,
    timestamp: "2026-08-14T04:27:48.412Z",
  };
}

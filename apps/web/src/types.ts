export type CandidateId = "legacy" | "A" | "B" | "C";
export type ModernCandidateId = Exclude<CandidateId, "legacy">;

export type EventSourceName =
  | "forge"
  | "daytona"
  | "snyk"
  | "rocketride"
  | "control";

export type RunEventType =
  | "RUN_QUEUED"
  | "RULES_LOCKED"
  | "SANDBOX_CREATED"
  | "SOURCE_READY"
  | "SCAN_COMPLETE"
  | "APP_HEALTHY"
  | "CORPUS_REPLAYED"
  | "DIVERGENCE_FOUND"
  | "GATE_RESULT"
  | "VERDICT_READY"
  | "NARRATED"
  | "APPROVED"
  | "TORN_DOWN";

export interface RunEvent {
  seq: number;
  ts: string;
  source: EventSourceName;
  type: string;
  candidateId?: CandidateId;
  message: string;
  payload?: unknown;
}

export interface ResourceAllocation {
  cpu: string;
  memory: string;
  disk: string;
  region: string;
}

export interface SandboxRecord {
  candidateId: CandidateId;
  sandboxId: string;
  snapshotId: string;
  commitSha: string;
  previewUrl: string;
  createdAt: string;
  resources: ResourceAllocation;
}

export interface DiffPart {
  text: string;
  different: boolean;
}

export interface LedgerValue {
  summary: string;
  parts: DiffPart[];
}

export interface LedgerRow {
  id: string;
  order: number;
  candidateId: ModernCandidateId;
  inputId: string;
  ruleId: string;
  probe: string;
  legacy: LedgerValue;
  candidate: LedgerValue;
  status: "MATCH" | "DIVERGENT";
  note: string;
}

export interface GateResult {
  candidateId: ModernCandidateId;
  key: string;
  category: "build" | "health" | "behavior" | "security";
  ruleId?: string;
  status: "PASS" | "FAIL";
  detail: string;
  inputId?: string;
}

export interface Finding {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  file: string;
  line: number;
}

export interface ScanResult {
  candidateId: ModernCandidateId;
  status: "CLEAN" | "FINDINGS" | "ERROR";
  findings: Finding[];
}

export interface CandidateVerdict {
  candidateId: ModernCandidateId;
  eligible: boolean;
  reasons: string[];
}

export interface Verdict {
  outcome: "RECOMMEND" | "BLOCKED" | "INCONCLUSIVE";
  recommended: ModernCandidateId | null;
  perCandidate: CandidateVerdict[];
  policyVersion: string;
}

export interface ApprovalRecord {
  digest: string;
  policyVersion: string;
  sandboxIds: string[];
  reviewer: string;
  comment: string;
  timestamp: string;
}

export interface ApprovalSubmission {
  reviewer: string;
  comment: string;
}

export interface ApprovalReceipt {
  digest: string;
}

export interface PresentationError {
  seq: number;
  eventType: string;
  message: string;
}

export interface RunView {
  sandboxes: SandboxRecord[];
  activeSandboxIds: Set<string>;
  ledgerRows: LedgerRow[];
  gates: GateResult[];
  scans: ScanResult[];
  presentationErrors: PresentationError[];
  verdict?: Verdict;
  narration?: string;
  approval?: ApprovalRecord;
}

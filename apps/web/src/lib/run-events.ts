import { z } from "zod";
import type {
  ApprovalRecord,
  GateResult,
  LedgerRow,
  PresentationError,
  RunEvent,
  RunView,
  SandboxRecord,
  ScanResult,
  Verdict,
} from "../types";

const candidateIdSchema = z.enum(["legacy", "A", "B", "C"]);
const modernCandidateIdSchema = z.enum(["A", "B", "C"]);

const runEventSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.string().refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      && !Number.isNaN(Date.parse(value)),
    "timestamp must be a parseable ISO-8601 date-time with a timezone",
  ),
  source: z.enum(["forge", "daytona", "snyk", "rocketride", "control"]),
  type: z.string().min(1),
  candidateId: candidateIdSchema.optional(),
  message: z.string().min(1),
  payload: z.unknown().optional(),
});

const resourceSchema = z.object({
  cpu: z.string(),
  memory: z.string(),
  disk: z.string(),
  region: z.string(),
});

const sandboxSchema = z.object({
  candidateId: candidateIdSchema,
  sandboxId: z.string(),
  snapshotId: z.string(),
  commitSha: z.string(),
  previewUrl: z.string(),
  createdAt: z.string(),
  resources: resourceSchema,
});

const diffPartSchema = z.object({
  text: z.string(),
  different: z.boolean(),
});

const ledgerValueSchema = z.object({
  summary: z.string(),
  parts: z.array(diffPartSchema),
});

const ledgerRowSchema = z.object({
  id: z.string(),
  order: z.number().int(),
  candidateId: modernCandidateIdSchema,
  inputId: z.string(),
  ruleId: z.string(),
  probe: z.string(),
  legacy: ledgerValueSchema,
  candidate: ledgerValueSchema,
  status: z.enum(["MATCH", "DIVERGENT"]),
  note: z.string(),
});

const gateSchema = z.object({
  candidateId: modernCandidateIdSchema,
  key: z.string(),
  category: z.enum(["build", "health", "behavior", "security"]),
  ruleId: z.string().optional(),
  status: z.enum(["PASS", "FAIL"]),
  detail: z.string(),
  inputId: z.string().optional(),
});

const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  title: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
});

const scanSchema = z.object({
  candidateId: modernCandidateIdSchema,
  status: z.enum(["CLEAN", "FINDINGS", "ERROR"]),
  findings: z.array(findingSchema),
});

const candidateVerdictSchema = z.object({
  candidateId: modernCandidateIdSchema,
  eligible: z.boolean(),
  reasons: z.array(z.string()),
});

const verdictSchema = z.object({
  outcome: z.enum(["RECOMMEND", "BLOCKED", "INCONCLUSIVE"]),
  recommended: modernCandidateIdSchema.nullable(),
  perCandidate: z.array(candidateVerdictSchema),
  policyVersion: z.string(),
});

const approvalSchema = z.object({
  digest: z.string(),
  policyVersion: z.string(),
  sandboxIds: z.array(z.string()),
  reviewer: z.string(),
  comment: z.string(),
  timestamp: z.string(),
});

const sandboxPayloadSchema = z.object({
  kind: z.literal("sandbox"),
  sandbox: sandboxSchema,
});
const ledgerPayloadSchema = z.object({
  kind: z.literal("ledger"),
  row: ledgerRowSchema,
  gate: gateSchema,
});
const scanPayloadSchema = z.object({
  kind: z.literal("scan"),
  scan: scanSchema,
});
const verdictPayloadSchema = z.object({
  kind: z.literal("verdict"),
  verdict: verdictSchema,
});
const narrationPayloadSchema = z.object({
  kind: z.literal("narration"),
  narration: z.string(),
});
const approvalPayloadSchema = z.object({
  kind: z.literal("approval"),
  approval: approvalSchema,
});
const teardownPayloadSchema = z.object({
  kind: z.literal("teardown"),
  sandboxId: z.string(),
});

function payloadError(event: RunEvent, error: z.ZodError): PresentationError {
  const detail = error.issues
    .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
    .join("; ");
  return {
    seq: event.seq,
    eventType: event.type,
    message: `Event ${event.seq} ${event.type} has an unreadable presentation payload (${detail}).`,
  };
}

export function parseRunEvent(value: unknown): RunEvent {
  return runEventSchema.parse(value) as RunEvent;
}

export function sortRunEvents(events: readonly RunEvent[]): RunEvent[] {
  const bySequence = new Map<number, RunEvent>();
  for (const event of events) {
    bySequence.set(event.seq, event);
  }
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

export function deriveRunView(events: readonly RunEvent[]): RunView {
  const sandboxes = new Map<string, SandboxRecord>();
  const activeSandboxIds = new Set<string>();
  const ledgerRows = new Map<string, LedgerRow>();
  const gates = new Map<string, GateResult>();
  const scans = new Map<string, ScanResult>();
  const presentationErrors: PresentationError[] = [];
  let verdict: Verdict | undefined;
  let narration: string | undefined;
  let approval: ApprovalRecord | undefined;

  for (const event of sortRunEvents(events)) {
    if (event.type === "SANDBOX_CREATED") {
      const result = sandboxPayloadSchema.safeParse(event.payload);
      if (result.success) {
        sandboxes.set(result.data.sandbox.sandboxId, result.data.sandbox);
        activeSandboxIds.add(result.data.sandbox.sandboxId);
      } else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "GATE_RESULT") {
      const result = ledgerPayloadSchema.safeParse(event.payload);
      if (result.success) {
        ledgerRows.set(result.data.row.id, result.data.row);
        const parsedGate = result.data.gate;
        const gate: GateResult = {
          candidateId: parsedGate.candidateId,
          key: parsedGate.key,
          category: parsedGate.category,
          status: parsedGate.status,
          detail: parsedGate.detail,
        };
        if (parsedGate.ruleId !== undefined) gate.ruleId = parsedGate.ruleId;
        if (parsedGate.inputId !== undefined) gate.inputId = parsedGate.inputId;
        gates.set(`${gate.candidateId}:${gate.key}:${gate.inputId ?? "all"}`, gate);
      } else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "SCAN_COMPLETE") {
      const result = scanPayloadSchema.safeParse(event.payload);
      if (result.success) scans.set(result.data.scan.candidateId, result.data.scan);
      else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "VERDICT_READY") {
      const result = verdictPayloadSchema.safeParse(event.payload);
      if (result.success) verdict = result.data.verdict;
      else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "NARRATED") {
      const result = narrationPayloadSchema.safeParse(event.payload);
      if (result.success) narration = result.data.narration;
      else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "APPROVED") {
      const result = approvalPayloadSchema.safeParse(event.payload);
      if (result.success) approval = result.data.approval;
      else presentationErrors.push(payloadError(event, result.error));
    }

    if (event.type === "TORN_DOWN") {
      const result = teardownPayloadSchema.safeParse(event.payload);
      if (result.success) activeSandboxIds.delete(result.data.sandboxId);
      else presentationErrors.push(payloadError(event, result.error));
    }
  }

  const view: RunView = {
    sandboxes: [...sandboxes.values()],
    activeSandboxIds,
    ledgerRows: [...ledgerRows.values()].sort((left, right) => left.order - right.order),
    gates: [...gates.values()],
    scans: [...scans.values()],
    presentationErrors,
  };

  if (verdict !== undefined) view.verdict = verdict;
  if (narration !== undefined) view.narration = narration;
  if (approval !== undefined) view.approval = approval;

  return view;
}

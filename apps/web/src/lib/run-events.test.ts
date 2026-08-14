import { describe, expect, it } from "vitest";
import { createMockApproval, createMockEvents } from "../data/mock-run";
import type { RunEvent } from "../types";
import { deriveRunView, parseRunEvent, sortRunEvents } from "./run-events";

describe("run event presentation model", () => {
  it("deduplicates and renders events in sequence order", () => {
    const events = createMockEvents("RUN-TEST-0001");
    const shuffled = [events[2], events[0], events[1], events[2]].filter(
      (event): event is RunEvent => event !== undefined,
    );

    expect(sortRunEvents(shuffled).map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("keeps all environment records while the live count returns to zero", () => {
    const events = createMockEvents("RUN-TEST-0002");
    const view = deriveRunView(events);
    const liveCounts = events.map((_, index) =>
      deriveRunView(events.slice(0, index + 1)).activeSandboxIds.size,
    );

    expect(view.sandboxes).toHaveLength(4);
    expect(view.activeSandboxIds.size).toBe(0);
    expect(Math.max(...liveCounts)).toBe(4);
    expect(liveCounts.slice(-4)).toEqual([3, 2, 1, 0]);
    expect(new Set(view.sandboxes.map((sandbox) => sandbox.snapshotId)).size).toBe(1);
    expect(
      new Set(view.sandboxes.map((sandbox) => JSON.stringify(sandbox.resources))).size,
    ).toBe(1);
  });

  it("uses precomputed ledger results without comparing response bodies", () => {
    const view = deriveRunView(createMockEvents("RUN-TEST-0003"));
    const candidateARows = view.ledgerRows.filter((row) => row.candidateId === "A");

    expect(view.ledgerRows).toHaveLength(21);
    expect(view.gates).toHaveLength(21);
    expect(candidateARows.filter((row) => row.status === "DIVERGENT")).toHaveLength(4);
    expect(view.verdict?.recommended).toBe("C");
    expect(view.scans.find((scan) => scan.candidateId === "B")?.status).toBe("FINDINGS");
  });

  it("accepts a canonical approval event and retains its signed packet metadata", () => {
    const events = createMockEvents("RUN-TEST-0004");
    const approval = createMockApproval("Bryan Lee", "Candidate C is cleared for release.");
    const lastSequence = events.at(-1)?.seq ?? 0;
    events.push({
      seq: lastSequence + 1,
      ts: approval.timestamp,
      source: "control",
      type: "APPROVED",
      message: "Approval packet signed.",
      payload: { kind: "approval", approval },
    });

    const view = deriveRunView(events);
    expect(view.approval?.digest).toBe(approval.digest);
    expect(view.approval?.sandboxIds).toHaveLength(4);
  });

  it("rejects malformed wire events", () => {
    expect(() => parseRunEvent({ seq: 0, source: "unknown" })).toThrow();
    expect(() => parseRunEvent({
      seq: 1,
      ts: "not-a-date",
      source: "control",
      type: "RUN_QUEUED",
      message: "Queued.",
    })).toThrow();
  });

  it("keeps newer event types as timeline-only records", () => {
    const event = parseRunEvent({
      seq: 99,
      ts: "2026-08-14T04:25:10.000Z",
      source: "control",
      type: "FUTURE_EVIDENCE_EVENT",
      message: "A newer control-plane event arrived.",
      payload: { version: 2 },
    });
    expect(event.type).toBe("FUTURE_EVIDENCE_EVENT");
    expect(deriveRunView([event]).presentationErrors).toEqual([]);
  });

  it("surfaces unreadable payloads for presentation-critical events", () => {
    const event = parseRunEvent({
      seq: 3,
      ts: "2026-08-14T04:25:12.000Z",
      source: "daytona",
      type: "SANDBOX_CREATED",
      message: "Sandbox created.",
      payload: { unexpected: true },
    });
    expect(deriveRunView([event]).presentationErrors[0]?.eventType).toBe("SANDBOX_CREATED");
  });
});

import { createMockApproval, createMockEvents } from "../data/mock-run";
import type { ApprovalReceipt, ApprovalSubmission, RunEvent } from "../types";
import type { IntentGuardEnv } from "./env";
import type { RunAdapter, RunCreated, SubscriptionCallbacks } from "./run-adapter";

interface MockSession {
  events: RunEvent[];
  cursor: number;
  subscribers: Set<SubscriptionCallbacks>;
  timer: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
}

class MockRunAdapter implements RunAdapter {
  private readonly sessions = new Map<string, MockSession>();
  private runCounter = 41;

  constructor(private readonly scenario: IntentGuardEnv["VITE_INTENTGUARD_MOCK_SCENARIO"]) {}

  async createRun(): Promise<RunCreated> {
    this.runCounter += 1;
    const runId = `RUN-20260813-${String(this.runCounter).padStart(4, "0")}`;
    this.sessions.set(runId, {
      events: createMockEvents(runId),
      cursor: 0,
      subscribers: new Set(),
      timer: undefined,
      stopped: false,
    });
    return { runId };
  }

  subscribe(runId: string, callbacks: SubscriptionCallbacks): () => void {
    const session = this.sessions.get(runId);
    if (session === undefined) {
      queueMicrotask(() => callbacks.onError(new Error(`Mock run ${runId} does not exist.`)));
      return () => undefined;
    }
    session.subscribers.add(callbacks);
    if (session.cursor === 0 && session.timer === undefined) this.scheduleNext(session);
    return () => session.subscribers.delete(callbacks);
  }

  async approve(runId: string, submission: ApprovalSubmission): Promise<ApprovalReceipt> {
    const session = this.sessions.get(runId);
    if (session === undefined) throw new Error(`Mock run ${runId} does not exist.`);
    const approval = createMockApproval(submission.reviewer, submission.comment);
    const approvedEvent: RunEvent = {
      seq: (session.events.at(-1)?.seq ?? 0) + 1,
      ts: approval.timestamp,
      source: "control",
      type: "APPROVED",
      message: `${submission.reviewer} approved the signed evidence packet.`,
      payload: { kind: "approval", approval },
    };
    setTimeout(() => this.broadcast(session, approvedEvent), 240);
    return { digest: approval.digest };
  }

  private broadcast(session: MockSession, event: RunEvent): void {
    for (const subscriber of session.subscribers) subscriber.onEvent(event);
  }

  private scheduleNext(session: MockSession): void {
    if (session.stopped || session.cursor >= session.events.length) return;
    const nextEvent = session.events[session.cursor];
    if (nextEvent === undefined) return;
    const delay = nextEvent.type === "SANDBOX_CREATED" || nextEvent.type === "GATE_RESULT"
      ? 150
      : nextEvent.type === "NARRATED" ? 420 : 230;

    session.timer = setTimeout(() => {
      session.timer = undefined;
      this.broadcast(session, nextEvent);
      session.cursor += 1;

      if (this.scenario === "error" && nextEvent.seq === 6) {
        session.stopped = true;
        const teardownEvents = session.events.filter((event) => event.type === "TORN_DOWN");
        teardownEvents.forEach((event, index) => {
          this.broadcast(session, { ...event, seq: nextEvent.seq + index + 1 });
        });
        for (const subscriber of session.subscribers) {
          subscriber.onError(
            new Error("Candidate B sandbox stopped before the health check completed."),
          );
        }
        return;
      }

      this.scheduleNext(session);
    }, delay);
  }
}

export function createMockRunAdapter(
  scenario: IntentGuardEnv["VITE_INTENTGUARD_MOCK_SCENARIO"],
): RunAdapter {
  return new MockRunAdapter(scenario);
}

import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntentGuardEnv } from "./env";
import { createRunAdapter } from "./run-adapter";
import { deriveRunView, sortRunEvents } from "./run-events";
import type { RunEvent } from "../types";

const baseConfig: IntentGuardEnv = {
  VITE_INTENTGUARD_DATA_MODE: "mock",
  VITE_INTENTGUARD_API_BASE_URL: "",
  VITE_INTENTGUARD_MOCK_SCENARIO: "success",
};

afterEach(() => vi.useRealTimers());

describe("mock run adapter", () => {
  it("plays the canonical sequence over time and emits approval through the subscription", async () => {
    vi.useFakeTimers();
    const adapter = createRunAdapter(baseConfig);
    const { runId } = await adapter.createRun();
    const events: RunEvent[] = [];
    const errors: Error[] = [];
    const unsubscribe = adapter.subscribe(runId, {
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });

    await vi.runAllTimersAsync();
    expect(errors).toEqual([]);
    expect(sortRunEvents(events).map((event) => event.seq)).toEqual(events.map((event) => event.seq));
    expect(deriveRunView(events).verdict?.recommended).toBe("C");
    expect(deriveRunView(events).activeSandboxIds.size).toBe(0);

    const receipt = await adapter.approve(runId, {
      reviewer: "Bryan Lee",
      comment: "Candidate C is cleared for release.",
    });
    await vi.runAllTimersAsync();
    expect(receipt.digest).toMatch(/^sha256:/);
    expect(events.at(-1)?.type).toBe("APPROVED");
    unsubscribe();
  });

  it("tears down every allocated sandbox before surfacing the mock failure", async () => {
    vi.useFakeTimers();
    const adapter = createRunAdapter({
      ...baseConfig,
      VITE_INTENTGUARD_MOCK_SCENARIO: "error",
    });
    const { runId } = await adapter.createRun();
    const events: RunEvent[] = [];
    const errors: Error[] = [];
    adapter.subscribe(runId, {
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });

    await vi.runAllTimersAsync();
    expect(errors[0]?.message).toContain("Candidate B sandbox stopped");
    expect(events.filter((event) => event.type === "TORN_DOWN")).toHaveLength(4);
    expect(deriveRunView(events).activeSandboxIds.size).toBe(0);
  });
});

import { z } from "zod";
import type {
  ApprovalReceipt,
  ApprovalSubmission,
  RunEvent,
} from "../types";
import type { IntentGuardEnv } from "./env";
import { parseRunEvent } from "./run-events";

export interface RunCreated {
  runId: string;
}

export interface SubscriptionCallbacks {
  onEvent: (event: RunEvent) => void;
  onError: (error: Error) => void;
}

export interface RunAdapter {
  createRun(): Promise<RunCreated>;
  subscribe(runId: string, callbacks: SubscriptionCallbacks): () => void;
  approve(runId: string, submission: ApprovalSubmission): Promise<ApprovalReceipt>;
}

const runCreatedSchema = z.object({ runId: z.string().min(1) });
const approvalReceiptSchema = z.object({ digest: z.string().min(1) });

function urlFor(baseUrl: string, path: string): string {
  return baseUrl === "" ? path : `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function jsonFrom(response: Response, context: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${context} failed with HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${context} returned invalid JSON: ${detail}`);
  }
}

class ApiRunAdapter implements RunAdapter {
  constructor(private readonly baseUrl: string) {}

  async createRun(): Promise<RunCreated> {
    const response = await fetch(urlFor(this.baseUrl, "/api/runs"), {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    return runCreatedSchema.parse(await jsonFrom(response, "Starting evaluation"));
  }

  subscribe(runId: string, callbacks: SubscriptionCallbacks): () => void {
    const stream = new EventSource(
      urlFor(this.baseUrl, `/api/runs/${encodeURIComponent(runId)}/events`),
    );

    const onMessage = (message: MessageEvent<string>) => {
      try {
        const value: unknown = JSON.parse(message.data);
        callbacks.onEvent(parseRunEvent(value));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        callbacks.onError(new Error(`Run event could not be read: ${detail}`));
        stream.close();
      }
    };

    const onStreamError = () => {
      if (stream.readyState === EventSource.CLOSED) {
        callbacks.onError(new Error("The run event stream closed before completion."));
      }
    };

    stream.addEventListener("message", onMessage as EventListener);
    stream.addEventListener("error", onStreamError);

    return () => {
      stream.removeEventListener("message", onMessage as EventListener);
      stream.removeEventListener("error", onStreamError);
      stream.close();
    };
  }

  async approve(runId: string, submission: ApprovalSubmission): Promise<ApprovalReceipt> {
    const response = await fetch(
      urlFor(this.baseUrl, `/api/runs/${encodeURIComponent(runId)}/approve`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(submission),
      },
    );
    return approvalReceiptSchema.parse(await jsonFrom(response, "Recording approval"));
  }
}

class LazyMockRunAdapter implements RunAdapter {
  private implementation: Promise<RunAdapter> | undefined;

  constructor(private readonly scenario: IntentGuardEnv["VITE_INTENTGUARD_MOCK_SCENARIO"]) {}

  private load(): Promise<RunAdapter> {
    this.implementation ??= import("./mock-run-adapter").then(({ createMockRunAdapter }) =>
      createMockRunAdapter(this.scenario),
    );
    return this.implementation;
  }

  async createRun(): Promise<RunCreated> {
    return (await this.load()).createRun();
  }

  subscribe(runId: string, callbacks: SubscriptionCallbacks): () => void {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void this.load()
      .then((adapter) => {
        if (!disposed) unsubscribe = adapter.subscribe(runId, callbacks);
      })
      .catch((error: unknown) => {
        if (!disposed) callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }

  async approve(runId: string, submission: ApprovalSubmission): Promise<ApprovalReceipt> {
    return (await this.load()).approve(runId, submission);
  }
}

export function createRunAdapter(config: IntentGuardEnv): RunAdapter {
  if (config.VITE_INTENTGUARD_DATA_MODE === "api") {
    return new ApiRunAdapter(config.VITE_INTENTGUARD_API_BASE_URL);
  }
  return new LazyMockRunAdapter(config.VITE_INTENTGUARD_MOCK_SCENARIO);
}

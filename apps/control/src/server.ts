import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { RunEvent, Rule } from "@intentguard/contracts";
import { z } from "zod";
import { approveRun } from "./approval.js";
import { emitEvent } from "./lib/events.js";
import type { ControlStore } from "./lib/store.js";
import { buildStoredReport, renderStoredReportMarkdown } from "./report.js";

export type ControlServerDefaults = {
  snapshotId: string;
  corpusVersion: string;
  policyVersion: string;
  candidateIds: string[];
};

export type ControlServerOptions = {
  store: ControlStore;
  defaults: ControlServerDefaults;
  loadRules: () => Promise<Rule[]>;
  afterApproval?: (runId: string) => Promise<void>;
  onError?: (error: unknown) => void;
};

export type ListeningControlServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

const approvalRequestSchema = z.object({
  reviewer: z.string().min(1),
  comment: z.string().min(1),
}).strict();

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,last-event-id",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { ...CORS, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function text(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, { ...CORS, "content-type": `${contentType}; charset=utf-8` });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 64 * 1024) throw new HttpError(413, "Request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  if (source === "") return {};
  try {
    return JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw new HttpError(400, `Request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function decodeRunId(encoded: string | undefined): string {
  if (encoded === undefined || encoded === "") throw new HttpError(400, "Run ID is required.");
  try {
    const runId = decodeURIComponent(encoded);
    if (runId === "" || runId.includes("/")) throw new Error("invalid run ID");
    return runId;
  } catch (error: unknown) {
    throw new HttpError(400, `Run ID is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireRun(store: ControlStore, runId: string): void {
  if (store.getRun(runId) === undefined) throw new HttpError(404, `Run ${runId} was not found.`);
}

function eventRecord(event: RunEvent): string {
  return `id: ${String(event.seq)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  store: ControlStore,
  runId: string,
): void {
  requireRun(store, runId);
  const header = request.headers["last-event-id"];
  const parsedAfter = typeof header === "string" && /^\d+$/u.test(header) ? Number(header) : 0;
  let lastSent = parsedAfter;
  let closed = false;
  let buffering = true;
  const buffered: RunEvent[] = [];
  let keepAlive: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (keepAlive !== undefined) clearInterval(keepAlive);
    unsubscribe?.();
    if (!response.writableEnded) response.end();
  };

  const send = (event: RunEvent): void => {
    if (closed || event.seq <= lastSent) return;
    response.write(eventRecord(event));
    lastSent = event.seq;
    if (event.type === "TORN_DOWN") close();
  };

  response.writeHead(200, {
    ...CORS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  unsubscribe = store.subscribe(runId, (event) => {
    if (buffering) buffered.push(event);
    else send(event);
  });
  for (const event of store.listEvents(runId, parsedAfter)) send(event);
  buffering = false;
  buffered.sort((left, right) => left.seq - right.seq).forEach(send);
  if (closed) return;
  keepAlive = setInterval(() => {
    if (!closed) response.write(": keep-alive\n\n");
  }, 15_000);
  request.once("close", close);
  response.once("error", close);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://control.local");
  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS);
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok", journalMode: options.store.getJournalMode() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/rules") {
    json(response, 200, await options.loadRules());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/runs") {
    const runId = `RUN-${randomUUID()}`;
    options.store.createRun({
      runId,
      snapshotId: options.defaults.snapshotId,
      corpusVersion: options.defaults.corpusVersion,
      policyVersion: options.defaults.policyVersion,
      candidateIds: options.defaults.candidateIds,
    });
    emitEvent(runId, {
      source: "control",
      type: "RUN_QUEUED",
      message: `Run ${runId} queued: ${String(options.defaults.candidateIds.length - 1)} candidates against the legacy baseline.`,
      payload: {
        snapshotId: options.defaults.snapshotId,
        corpusVersion: options.defaults.corpusVersion,
        policyVersion: options.defaults.policyVersion,
        candidateIds: options.defaults.candidateIds.filter((candidateId) => candidateId !== "legacy"),
      },
    });
    json(response, 201, { runId });
    return;
  }

  const eventMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/u);
  if (request.method === "GET" && eventMatch !== null) {
    streamEvents(request, response, options.store, decodeRunId(eventMatch[1]));
    return;
  }

  const approvalMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/approve$/u);
  if (request.method === "POST" && approvalMatch !== null) {
    const runId = decodeRunId(approvalMatch[1]);
    requireRun(options.store, runId);
    const parsed = approvalRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new HttpError(400, `Approval request is invalid: ${detail}`);
    }
    let receipt;
    try {
      receipt = approveRun(runId, parsed.data, options.store);
    } catch (error: unknown) {
      throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
    if (options.afterApproval !== undefined) {
      try {
        await options.afterApproval(runId);
      } catch (error: unknown) {
        options.onError?.(new Error(`Post-approval teardown failed for run ${runId}.`, { cause: error }));
      }
    }
    json(response, 200, receipt);
    return;
  }

  const jsonReportMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/report\.json$/u);
  if (request.method === "GET" && jsonReportMatch !== null) {
    const runId = decodeRunId(jsonReportMatch[1]);
    requireRun(options.store, runId);
    json(response, 200, buildStoredReport(runId, options.store));
    return;
  }

  const markdownReportMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/report\.md$/u);
  if (request.method === "GET" && markdownReportMatch !== null) {
    const runId = decodeRunId(markdownReportMatch[1]);
    requireRun(options.store, runId);
    text(response, 200, "text/markdown", renderStoredReportMarkdown(runId, options.store));
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/u);
  if (request.method === "GET" && runMatch !== null) {
    const runId = decodeRunId(runMatch[1]);
    requireRun(options.store, runId);
    json(response, 200, options.store.getSnapshot(runId));
    return;
  }

  throw new HttpError(404, `No route for ${request.method ?? "UNKNOWN"} ${url.pathname}.`);
}

export function createControlServer(options: ControlServerOptions): Server {
  return createServer((request, response) => {
    void route(request, response, options).catch((error: unknown) => {
      if (response.headersSent) {
        options.onError?.(error);
        if (!response.writableEnded) response.end();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) options.onError?.(error);
      const message = error instanceof Error ? error.message : String(error);
      json(response, status, {
        error: status === 500 ? "internal_error" : "request_error",
        message: status === 500 ? "The control API could not complete the request." : message,
      });
    });
  });
}

export async function listenControlServer(
  server: Server,
  port: number,
  host = "127.0.0.1",
): Promise<ListeningControlServer> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Control server did not expose a TCP address.");
  }
  const { port: listeningPort } = address as AddressInfo;
  return {
    server,
    url: `http://${host}:${String(listeningPort)}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
      server.closeAllConnections();
    }),
  };
}

import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import {
  generateCorpus,
  replay,
  ReplayRequestError,
  type CorpusInput,
  type Rule,
} from "../src/index.js";

const RUN_ID = "run-smoke-fixture";

const rules: Rule[] = [
  {
    id: "REQ-014",
    title: "Truncated threshold",
    behavior: "Amounts from 500.00 to 500.99 remain under the threshold",
    boundaries: ["499.99", "500.00", "500.49", "500.99", "501.00"],
    blocking: true,
  },
  {
    id: "REQ-022",
    title: "Last business day",
    behavior: "The role check is skipped on the final business day",
    boundaries: ["2026-01-29", "2026-01-30T12:00:00Z"],
    blocking: true,
  },
  {
    id: "REQ-007",
    title: "Audit actor",
    behavior: "Approval audit records contain the actor",
    boundaries: ["smoke-actor"],
    blocking: true,
  },
];

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = raw === "" ? null : JSON.parse(raw);
  return parsed;
}

async function main(): Promise<void> {
  const corpus = generateCorpus(RUN_ID, rules);

  assert.equal(corpus.length, 8);
  assert.deepEqual(
    corpus.map((input) => input.id),
    [
      "IN-0001",
      "IN-0002",
      "IN-0003",
      "IN-0004",
      "IN-0005",
      "IN-0006",
      "IN-0007",
      "IN-0008",
    ],
  );
  assert.deepEqual(
    corpus.slice(0, 5).map((input) => input.payload.amount),
    ["499.99", "500.00", "500.49", "500.99", "501.00"],
  );
  assert.equal(corpus[5]?.payload.requested_at, "2026-01-29");
  assert.equal(corpus[6]?.payload.requested_at, "2026-01-30T12:00:00Z");
  assert.equal(corpus[7]?.payload.actor, "smoke-actor");
  assert.ok(corpus.every((input) => input.path === "/refunds/approve"));
  assert.throws(
    () =>
      generateCorpus(RUN_ID, [
        {
          id: "REQ-022",
          title: "Last business day",
          behavior: "The role check is skipped on the final business day",
          boundaries: ["2026-01-30T12:00:00.000Z"],
          blocking: true,
        },
      ]),
    /run-smoke-fixture.*REQ-022.*YYYY-MM-DDTHH:MM:SSZ/u,
  );
  assert.throws(
    () =>
      generateCorpus(RUN_ID, [
        {
          id: "REQ-022",
          title: "Last business day",
          behavior: "The role check is skipped on the final business day",
          boundaries: ["2026-02-29"],
          blocking: true,
        },
      ]),
    /run-smoke-fixture.*REQ-022.*not a valid calendar date/u,
  );

  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }

      const requestBody = await readRequestBody(request);
      response.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ method: request.method, requestBody }));
    } catch (error: unknown) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const previewUrl = `http://127.0.0.1:${address.port}`;
    const results = await replay(
      RUN_ID,
      previewUrl,
      corpus.slice(0, 2),
      "smoke-candidate",
    );

    assert.equal(results.length, 2);
    assert.equal(results[0]?.candidateId, "smoke-candidate");
    assert.equal(results[0]?.inputId, "IN-0001");
    assert.equal(results[0]?.status, 202);
    assert.ok((results[0]?.latencyMs ?? -1) >= 0);
    assert.deepEqual(results[0]?.body, {
      method: "POST",
      requestBody: corpus[0]?.payload,
    });

    const healthInput: CorpusInput = {
      id: "IN-HEALTH",
      ruleId: "health",
      method: "GET",
      path: "/health",
      payload: {},
    };
    const [health] = await replay(
      RUN_ID,
      previewUrl,
      [healthInput],
      "smoke-candidate",
    );

    assert.equal(health?.status, 200);
    assert.deepEqual(health?.body, { status: "ok" });

    await assert.rejects(
      replay(RUN_ID, "not a URL", [healthInput], "broken-candidate"),
      (error: unknown) =>
        error instanceof ReplayRequestError &&
        error.runId === RUN_ID &&
        error.candidateId === "broken-candidate" &&
        error.inputId === "IN-HEALTH",
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  console.log("fixture smoke test passed");
}

main().catch((error: unknown) => {
  console.error("fixture smoke test failed", error);
  process.exitCode = 1;
});

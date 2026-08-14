# IntentGuard control plane

The control package owns durable run state, append-only events, behavioral
comparison, deterministic policy, approval receipts, and stored-evidence
reports. The committed mock remains a separate development path.

## Requirements

- Node.js 22.5 or newer (`node:sqlite` is used directly)
- pnpm 11
- A Forge-exported `Rule[]` file at `forge/rules.json` or `FORGE_RULES_PATH`

Forge artifacts are intentionally not synthesized by this package. If the
rules export is absent or invalid, `GET /api/rules` and worker rule loading fail
with the artifact path and parse context instead of substituting demo data.

## Real API

From the repository root:

```sh
pnpm dev:control
```

Configuration is documented in the root `.env.example`. The server enables
SQLite WAL mode for file-backed databases and exposes:

- `GET /health`
- `GET /api/rules`
- `POST /api/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/events` (named SSE records, resumable with `Last-Event-ID`)
- `POST /api/runs/:id/approve`
- `GET /api/runs/:id/report.json`
- `GET /api/runs/:id/report.md`

`POST /api/runs` persists a `DRAFT` run. The worker is composed separately by
injecting the Forge, corpus, execution, scan, replay, narration, and teardown
ports into `runWorkerLoop`. This separation keeps the real path honest while
the execution package is integrated; the API never fabricates execution or
scan evidence.

Recommended runs retain their sandboxes during human review. A server
composition can pass `afterApproval` and call `teardownApprovedRun` so the
execution adapter emits `TORN_DOWN` only after `APPROVED`. Blocked and failed
runs are torn down by the worker immediately.

## Event and evidence invariants

- All control-owned events go through the configured `emitEvent` writer.
- Event sequence allocation and insertion share one immediate transaction.
- Comparison uses HTTP status plus recursive JSON field comparison; object key
  order and whitespace do not create false divergences.
- Policy is a pure function with no clock, database, network, or model call.
- A verdict is stored before `VERDICT_READY` and before narration.
- Approval is atomic and only accepts a stored `RECOMMEND` verdict in
  `AWAITING_APPROVAL`.
- Approval SHA-256 binds canonical rules, corpus, raw results, scans, gates,
  and verdict. Reports are regenerated only from those stored records.

## Verification

```sh
pnpm --filter @intentguard/control typecheck
pnpm --filter @intentguard/control smoke
pnpm smoke:control
```

The core smoke uses a real temporary SQLite database and exercises WAL,
comparison, policy, worker success/failure paths, HTTP, SSE, approval,
post-approval teardown, tamper detection, and both report formats. The existing
`smoke:control` command continues to verify the canonical timed mock used by the
web package.

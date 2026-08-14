# IntentGuard

IntentGuard replays rule-derived boundary inputs against a legacy refund service
and modernization candidates, then presents the control plane's evidence as a
reconciliation ledger and signed approval packet.

This checkout contains Bryan's owned surfaces:

- `packages/fixture`: the legacy service, candidates A/B/C, deterministic corpus
  generator, raw replay client, and regression smoke tests.
- `fixtures/expected.json`: pinned outcomes for the seven required approval
  cases across all four services.
- `apps/web`: the strict TypeScript reconciliation interface and its
  SSE-compatible development run adapter.

## Prerequisites

- Node.js 20 or newer
- pnpm 11
- Python 3.8 or newer for local verification; the legacy service also remains
  compatible with Python 2.7

Install the workspace once from the repository root:

```sh
pnpm install
```

## Run a fixture

Every service uses the standard library and starts with one command. It listens
on port 8080 unless `--port` is supplied.

```sh
python packages/fixture/legacy/server.py
python packages/fixture/candidates/A/server.py --port 8081
python packages/fixture/candidates/B/server.py --port 8082
python packages/fixture/candidates/C/server.py --port 8083
```

Each exposes `GET /health`, `POST /refunds/approve`, and `GET /audit`. The full
request contract and candidate notes are in `packages/fixture/README.md`.

## Verify fixture behavior

```sh
pnpm --filter @intentguard/fixture build
pnpm --filter @intentguard/fixture exec tsx scripts/smoke-fixture.ts
pnpm --filter @intentguard/fixture exec tsx scripts/smoke-services.ts python
```

The service regression smoke test starts and tears down every fixture, compares
all 28 status/body outcomes with `fixtures/expected.json`, and checks the four
audit totals.

## Run the interface

```sh
pnpm --filter @intentguard/web dev
```

Run the canonical control-plane mock and the web client in separate terminals:

```sh
pnpm mock:serve
pnpm dev:web
```

Development mock mode consumes the real SSE stream at `http://localhost:4000`.
Set the values documented in `apps/web/.env.example` to use another control
origin or the real API mode. Production defaults to the real API path. Event
payload normalization is isolated in `apps/web/src/lib/run-events.ts`;
component code does not compare candidate behavior or apply policy.

```sh
pnpm --filter @intentguard/web typecheck
pnpm --filter @intentguard/web test
pnpm --filter @intentguard/web build
```

See `apps/web/README.md` for the presentation payloads expected inside the
shared `RunEvent` envelope.

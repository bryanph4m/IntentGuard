# IntentGuard

IntentGuard decides whether an AI-rewritten service is safe to ship. It runs
every rewrite candidate against a corpus of inputs derived from business rules
recovered from the legacy source, compares each candidate's behavior to what
the legacy system actually does, and turns any divergence into evidence a
human can approve or block.

The expected values come from the legacy system's observed behavior, not from
anyone's belief about what it should be. The rule-recovery model explains a
result; it never votes on pass or fail. Execution decides.

## Table of contents

- [Problem statement](#problem-statement)
- [Solution](#solution)
- [State machine](#state-machine)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
  - [Run the legacy and candidate fixtures](#run-the-legacy-and-candidate-fixtures)
  - [Verify fixture behavior](#verify-fixture-behavior)
  - [Run the interface against the mock](#run-the-interface-against-the-mock)
  - [Run the real control API](#run-the-real-control-api)
- [Module ownership](#module-ownership)
- [Events](#events)
- [Where fallbacks are and are not allowed](#where-fallbacks-are-and-are-not-allowed)
- [Verification commands](#verification-commands)
- [Non-negotiables](#non-negotiables)

## Problem statement

An agent can rewrite a legacy service in minutes. Nobody can tell, from
reading the diff or the agent's own explanation, whether the rewrite actually
preserves the legacy system's behavior. Legacy business rules are frequently
undocumented — the only source of truth is the code itself, including edge
cases nobody wrote down (rounding, threshold boundaries, negative-amount
handling, role checks). A rewrite that looks correct and passes a hand-written
test suite can still silently change what happens at those edges, and the
first place that shows up is production.

Trusting the agent's own account of its rewrite — or a model's opinion on
whether the diff "looks right" — reintroduces exactly the risk the rewrite was
supposed to fix.

## Solution

IntentGuard treats correctness as an empirical question, not an opinion:

1. **Recover intent.** Forge reads the legacy source and produces a rules
   export (`forge/rules.json`) — the business rules actually implemented by
   the legacy system, including the ones nobody documented.
2. **Generate a corpus.** A deterministic corpus generator turns those rules
   into concrete boundary-condition inputs (`packages/fixture`).
3. **Execute, don't ask.** Every candidate is provisioned in an isolated
   sandbox and replayed against the same corpus the legacy service is replayed
   against (`packages/execution`).
4. **Compare, don't guess.** Candidate responses are compared to legacy
   responses by HTTP status and recursive JSON field comparison — key order
   and whitespace never create a false divergence.
5. **Scan before trusting.** Every candidate is scanned (Snyk) before its
   comparison result is trusted; a scanner failure is a blocking error, never
   a silent pass.
6. **Decide with a pure function.** A deterministic policy function — no
   clock, no database, no network, no model call — turns comparison and scan
   results into a verdict.
7. **Explain, don't decide.** A narration step describes the already-final
   verdict in prose. It is handed the verdict and forbidden from
   recomputing it.
8. **Human approves.** A human reviews the evidence and approves or blocks.
   Approval is atomic, only accepts a stored `RECOMMEND` verdict, and produces
   a SHA-256 digest binding the rules, corpus, raw results, scans, gates, and
   verdict together — so the report can't drift from what was actually run.

## State machine

One run-level state machine drives every run:

```
DRAFT -> RULES_LOCKED -> PROVISIONING -> EVALUATING -> AGGREGATING -> AWAITING_APPROVAL -> APPROVED | BLOCKED
```

Each candidate additionally carries its own status string and failure reason.
There is no second state machine.

## Repository layout

```
apps/
  control/     durable run state, worker, comparison, policy, SSE, approval, reports
  web/         strict TypeScript reconciliation interface (React/Vite)
packages/
  contracts/   frozen, type-only wire/domain contracts shared by every module
  execution/   the only code that talks to Daytona, Snyk, and RocketRide
  fixture/     legacy service, candidates A/B/C, corpus generator, replay client
fixtures/      pinned expected outcomes for the required approval cases
forge/         Forge mission, recovered rules export, generated specs
```

## Prerequisites

- Node.js 22.5 or newer (the control plane uses the built-in `node:sqlite`
  module)
- pnpm 11
- Python 3.8 or newer to run the fixtures locally; the legacy fixture also
  stays compatible with Python 2.7

Install the workspace once from the repository root:

```sh
pnpm install
```

## Quick start

### Run the legacy and candidate fixtures

Every fixture is a standalone standard-library HTTP service and starts with
one command. Each listens on port 8080 unless `--port` (or `PORT`) is
supplied.

```sh
python packages/fixture/legacy/server.py
python packages/fixture/candidates/A/server.py --port 8081
python packages/fixture/candidates/B/server.py --port 8082
python packages/fixture/candidates/C/server.py --port 8083
```

Each exposes `GET /health`, `POST /refunds/approve`, `GET /audit`, and
`POST /fees/quote`. The full request contract, candidate behavior differences,
and the Candidate B security-scanner fixture are documented in
`packages/fixture/README.md`.

### Verify fixture behavior

```sh
pnpm --filter @intentguard/fixture build
pnpm --filter @intentguard/fixture exec tsx scripts/smoke-fixture.ts
pnpm --filter @intentguard/fixture exec tsx scripts/smoke-services.ts python
```

This starts and tears down every fixture, compares all 28 status/body outcomes
against `fixtures/expected.json`, and checks the four audit totals.

### Run the interface against the mock

`apps/control/src/mock-run.ts` is a runnable fake whose event shapes are the
canonical wire format — every real module must match them. Run it and the web
client in separate terminals:

```sh
pnpm mock:serve
pnpm dev:web
```

The web client's development mode consumes the real SSE stream at
`http://localhost:4000`; the bundle itself contains no synthetic run evidence.
Set the values documented in `apps/web/.env.example` to point at another
control origin or switch to the real API mode. See `apps/web/README.md` for
the canonical event payload table.

```sh
pnpm --filter @intentguard/web typecheck
pnpm --filter @intentguard/web test
pnpm --filter @intentguard/web build
```

### Run the real control API

Place a real Forge export at `forge/rules.json` (or point `FORGE_RULES_PATH`
at it), configure `.env.example` as needed, then:

```sh
pnpm dev:control
```

The API persists queued runs and serves snapshots, named SSE events, approval,
and reports:

- `GET /health`
- `GET /api/rules`
- `POST /api/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/events` (resumable via `Last-Event-ID`)
- `POST /api/runs/:id/approve`
- `GET /api/runs/:id/report.json`
- `GET /api/runs/:id/report.md`

Real worker execution is composed by injecting the Forge, corpus, execution,
scan, replay, narration, and teardown ports into `runWorkerLoop` — the API
never substitutes the mock for a missing Forge or execution adapter. See
`apps/control/README.md` for the full route list and event/evidence
invariants.

## Module ownership

Three people run parallel agent sessions against this repo. Ownership is
strict to avoid three divergent codebases:

| Owner | Owns | Paths |
| --- | --- | --- |
| Laksh | Forge, control API, worker, comparison, policy, evidence, report | `packages/contracts`, `apps/control`, `forge/` |
| Neel | Everything that talks to a third party: Daytona, Snyk, RocketRide | `packages/execution` |
| Bryan | Everything the user sees and everything being tested: legacy fixture, candidates, corpus, replay harness, frontend | `packages/fixture`, `apps/web` |

`packages/contracts` is frozen and type-only — it changes only by
announcement, and it must never gain a runtime value. Cross-module data flows
through imported contract types, not by reaching into another owner's module.

## Events

Every module emits its own events. A function that takes `runId` as its first
argument calls `emitEvent(runId, ...)` itself — Neel's adapter emits
`SANDBOX_CREATED`, Laksh's worker does not emit it on Neel's behalf. Events
are append-only and carry a monotonic `seq`; render from `seq` order, never
arrival order. `source` tags each event with the platform that produced it.

## Where fallbacks are and are not allowed

Allowed to degrade: RocketRide narration text, ForgeScore display, cosmetic
timeline detail, and the rules list (falls back to the committed
`forge/rules.json` if the live Forge export fails).

Never faked: sandbox creation, scan results, corpus replay, divergence
detection, or the verdict. A candidate that cannot run renders as
`ENVIRONMENT_ERROR` with an `INCONCLUSIVE` verdict rather than a synthetic
pass.

## Verification commands

```sh
pnpm typecheck:all       # root + every package
pnpm test                # every package's test suite
pnpm smoke:fixture       # legacy + candidate services against fixtures/expected.json
pnpm smoke:execution     # deterministic execution-plane smoke (injected adapters)
pnpm smoke:control       # canonical mock still satisfies the contract
pnpm smoke:control-core  # real SQLite-backed control plane, end to end
```

## Non-negotiables

- Strict TypeScript. No `any`, no unexplained `@ts-expect-error`.
- All environment variables flow through `src/lib/env.ts` with a zod schema —
  never read `process.env` directly.
- No silent error swallowing. A swallowed Snyk failure becomes a false
  approval, which is the exact failure mode this product exists to prevent.
- No `process.exit()` outside `scripts/`.
- Smoke tests live at `scripts/smoke-<module>.ts` and exit non-zero on
  failure.
- Commit format: `<type>(<module>): <imperative summary>`. Commit often, merge
  to main constantly.

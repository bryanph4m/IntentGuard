# IntentGuard web

The web client is a strict TypeScript React/Vite application. It renders canonical
`RunEvent` records in sequence order and treats event payloads as presentation-ready
evidence. Candidate comparison, security policy, verdict selection, and narration stay
outside the browser.

## Data adapters

Development defaults to `mock` mode. Production defaults to `api` when no explicit mode is
set, and the mock adapter plus synthetic evidence are loaded only through a development
dynamic import. The mock plays a stable, timed run through the same `RunAdapter` used by
the control API. It includes four matching sandboxes, Candidate A behavior divergence,
Candidate B's critical security block, Candidate C's recommendation, teardown, and the
approval packet.

The event envelope follows the shared `RunEvent` contract. Components do not inspect raw
payloads. `src/lib/run-events.ts` is the single normalization boundary and recognizes these
optional presentation payloads:

| Event | Payload |
| --- | --- |
| `SANDBOX_CREATED` | `{ kind: "sandbox", sandbox: SandboxRecord }` |
| `GATE_RESULT` | `{ kind: "ledger", row: LedgerRow, gate: GateResult }` |
| `SCAN_COMPLETE` | `{ kind: "scan", scan: ScanResult }` |
| `VERDICT_READY` | `{ kind: "verdict", verdict: Verdict }` |
| `NARRATED` | `{ kind: "narration", narration: string }` |
| `TORN_DOWN` | `{ kind: "teardown", sandboxId: string }` |
| `APPROVED` | `{ kind: "approval", approval: ApprovalRecord }` |

Unknown or newer payloads still render in the append-only timeline. Add their normalization
in `run-events.ts`; the UI components should not need to change.

The local contract interfaces in `src/types.ts` are a temporary, isolated integration seam
while `packages/contracts` is unavailable in this working tree. Replace them with type-only
imports from the frozen package after integration; do not fork or reinterpret those contracts
inside components.

Copy `.env.example` to `.env.local` only for local work. Set
`VITE_INTENTGUARD_DATA_MODE=api` to use:

- `POST /api/runs`
- `GET /api/runs/:id/events` through browser `EventSource`
- `POST /api/runs/:id/approve`

Use `VITE_INTENTGUARD_MOCK_SCENARIO=error` to exercise the interrupted-run state. That
scenario still emits teardown evidence for every allocated sandbox before surfacing the error.

## Commands

From the workspace root:

```text
pnpm --filter @intentguard/web dev
pnpm --filter @intentguard/web build
pnpm --filter @intentguard/web typecheck
pnpm --filter @intentguard/web test
```

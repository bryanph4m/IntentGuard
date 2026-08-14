# IntentGuard execution plane

This package is the only code that talks to Daytona, Snyk, and RocketRide. Its
public entry point exports exactly `provision`, `scan`, `teardown`, and
`narrate`; every function takes `runId` first and emits its own canonical run
events through the control plane's central event writer.

## Lifecycle

`provision` creates all requested Daytona sandboxes concurrently from the same
snapshot. It applies identical CPU, memory, disk, TTL, timeout, and network
settings, checks out each configured immutable commit, runs Snyk before any app
install/start command, waits for `/health`, and returns signed preview URLs.
Partial provisioning failures are cleaned up before the error is returned.

`scan` returns the scan captured before app startup and emits `SCAN_COMPLETE`.
Scanner crashes, timeouts, unsupported projects, malformed JSON, and incomplete
findings become `ERROR`; they are never reported as clean. The Snyk token is
passed only to `snyk code test --json` and is never persisted in the sandbox.

`teardown` deletes all run sandboxes in parallel. It is idempotent and can
rediscover sandboxes by Daytona labels after a process restart.

`narrate` supplies the already-final verdict and gates to RocketRide with an
instruction that forbids recomputation. The frozen worker ABI requires a
string, so RocketRide failures return and emit an explicit
`Narration unavailable: ...` string rather than fabricated prose.

## Verification

The deterministic package smoke uses injected adapters and no external
services:

```powershell
pnpm --filter @intentguard/execution test
```

Credentialed live smoke scripts use the real SDKs and exit nonzero on failure:

```powershell
pnpm --filter @intentguard/execution smoke:daytona -- <snapshot-id>
pnpm --filter @intentguard/execution smoke:snyk -- <snapshot-id>
pnpm --filter @intentguard/execution smoke:rocketride
```

Copy `.env.example` to an ignored local environment file and replace every
placeholder before running them. `fixtures/sandboxes.json` and
`fixtures/scans.json` must be created only from those credentialed runs; this
repository does not fabricate third-party output when credentials are absent.

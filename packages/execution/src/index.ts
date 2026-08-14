/**
 * packages/execution
 *
 * Owner: Neel. Everything that talks to a third party: Daytona, Snyk, RocketRide.
 * Path reserved in hour 0 so nobody creates a competing directory.
 *
 * Expected exports, per the shared contracts doc. Each takes runId first and
 * calls emitEvent(runId, ...) itself; Laksh's worker does not emit on your
 * behalf.
 *
 *   provision(runId, candidateIds: CandidateId[], snapshotId: string): Promise<SandboxRef[]>  // parallel
 *   scan(runId, ref: SandboxRef): Promise<ScanResult>
 *   teardown(runId: string): Promise<void>
 *   narrate(runId, verdict: Verdict, gates: GateResult[]): Promise<string>
 *
 * Replace this file. Do not change its path.
 */
export {};

/**
 * packages/fixture
 *
 * Owner: Bryan. Everything being tested: legacy service, candidates A/B/C,
 * corpus generator, replay harness.
 * Path reserved in hour 0 so nobody creates a competing directory.
 *
 * Expected exports, per the shared contracts doc. Each takes runId first and
 * calls emitEvent(runId, ...) itself.
 *
 *   generateCorpus(runId, rules: Rule[]): CorpusInput[]
 *   replay(runId, previewUrl: string, corpus: CorpusInput[], candidateId: CandidateId): Promise<RawResult[]>
 *
 * Replace this file. Do not change its path.
 */
export {};

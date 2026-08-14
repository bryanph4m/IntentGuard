/**
 * Structural mirrors of the frozen shared contracts.
 *
 * The contracts package is intentionally not a dependency yet: this package can
 * be built while packages/contracts is being landed, and callers using the
 * frozen shared types remain structurally compatible with these definitions.
 */
export type Rule = {
  id: string;
  title: string;
  behavior: string;
  boundaries: string[];
  blocking: boolean;
};

export type CorpusInput = {
  id: string;
  ruleId: string;
  method: "GET" | "POST";
  path: string;
  payload: Record<string, unknown>;
};

export type RawResult = {
  candidateId: string;
  inputId: string;
  status: number;
  body: unknown;
  latencyMs: number;
};

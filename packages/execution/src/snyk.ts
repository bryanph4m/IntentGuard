import type { CandidateId, Finding, ScanResult, Severity } from "@intentguard/contracts";
import { z } from "zod";
import type { CommandResult, SandboxPort } from "./lib/ports.js";

const severitySchema = z.enum(["low", "medium", "high", "critical"]);
const locationSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
}).strict();
const findingSchema = z.object({
  id: z.string().min(1),
  severity: severitySchema,
  title: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  locations: z.array(locationSchema).optional(),
}).passthrough();
const resultSchema = z.object({
  vulnerabilities: z.array(findingSchema).optional(),
  issues: z.array(findingSchema).optional(),
}).passthrough();

export type SnykConfig = { token: string; cliPath: string; timeoutSeconds: number };

function rawError(candidateId: CandidateId, raw: unknown): ScanResult {
  return { candidateId, status: "ERROR", findings: [], raw };
}

function findingLocation(value: z.infer<typeof findingSchema>): { file: string; line: number } | undefined {
  if (value.file !== undefined && value.line !== undefined) return { file: value.file, line: value.line };
  return value.locations?.[0];
}

function mapFindings(values: z.infer<typeof findingSchema>[]): Finding[] | undefined {
  const findings: Finding[] = [];
  for (const value of values) {
    const location = findingLocation(value);
    if (location === undefined) return undefined;
    findings.push({
      id: value.id,
      severity: value.severity as Severity,
      title: value.title,
      file: location.file,
      line: location.line,
    });
  }
  return findings;
}

export function parseSnykResult(candidateId: CandidateId, command: CommandResult): ScanResult {
  let raw: unknown;
  try {
    raw = JSON.parse(command.output);
  } catch (error: unknown) {
    return rawError(candidateId, {
      exitCode: command.exitCode,
      output: command.output,
      parseError: error instanceof Error ? error.message : String(error),
    });
  }
  if (command.exitCode !== 0 && command.exitCode !== 1) {
    return rawError(candidateId, raw);
  }
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return rawError(candidateId, raw);
  const values = parsed.data.vulnerabilities ?? parsed.data.issues ?? [];
  const findings = mapFindings(values);
  if (findings === undefined) return rawError(candidateId, raw);
  if (command.exitCode === 1 && findings.length === 0) return rawError(candidateId, raw);
  return {
    candidateId,
    status: findings.length === 0 ? "CLEAN" : "FINDINGS",
    findings,
    raw,
  };
}

export async function scanSandbox(
  candidateId: CandidateId,
  sandbox: SandboxPort,
  cwd: string,
  config: SnykConfig,
): Promise<ScanResult> {
  try {
    const command = await sandbox.execute(
      `${config.cliPath} code test --json`,
      cwd,
      { SNYK_TOKEN: config.token },
      config.timeoutSeconds,
    );
    return parseSnykResult(candidateId, command);
  } catch (error: unknown) {
    return rawError(candidateId, {
      executionError: error instanceof Error ? error.message : String(error),
    });
  }
}

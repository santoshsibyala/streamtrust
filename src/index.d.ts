export const VERSION: string;
export type Classification = 'PASS' | 'FAIL' | 'UNSUPPORTED' | 'HARNESS_ERROR';
export interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}
export interface ExternalObservation {
  checks: Check[];
  evidence: unknown;
  unsupported?: string;
}
export interface AdapterContext {
  repetition: number;
  outputDir: string;
  signal?: AbortSignal;
}
export interface FactoryContext {
  outputDir: string;
  signal: AbortSignal;
}
export interface ExternalAppAdapter {
  name: string;
  scenarios: readonly string[];
  metadata(): Promise<Record<string, unknown>>;
  run(scenario: string, context: AdapterContext): Promise<ExternalObservation>;
  close(): Promise<void>;
}
export type AdapterFactory = (
  context: FactoryContext,
) => Promise<ExternalAppAdapter>;
export interface CaseResult {
  scenario: string;
  repetition: number;
  classification: Classification;
  durationMs: number;
  checks: Check[];
  evidence?: unknown;
  error?: string;
  unsupported?: string;
}
export interface Report {
  schemaVersion: number;
  version: string;
  runId: string;
  adapter: string;
  generatedAt: string;
  repetitions: number;
  scenarios: string[];
  metadata: unknown;
  metadataAfter: unknown;
  counts: Partial<Record<Classification, number>>;
  results: CaseResult[];
  suiteErrors: string[];
  complete: boolean;
  exitCode: number;
}
export function classifyExternal(result: unknown): Classification;
export function validateAdapter(adapter: unknown): void;
export function runVerification(
  adapter: ExternalAppAdapter,
  outputDir: string,
  repetitions?: number,
  options?: { signal?: AbortSignal; runId?: string },
): Promise<Report>;
export function verifyExternal(
  adapter: ExternalAppAdapter,
  outputDir: string,
  repetitions?: number,
): Promise<CaseResult[]>;
export function writeReports(outputDir: string, report: Report): Promise<void>;
export function failureReport(
  outputDir: string,
  runId: string,
  error: unknown,
): Promise<Report>;

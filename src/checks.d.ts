import type { ExternalObservation } from './index.js';
export type LifecycleScenario =
  | 'persistence'
  | 'cancellation'
  | 'regeneration'
  | 'error-retry';
export const LIFECYCLE_SCENARIOS: readonly LifecycleScenario[];
export interface LifecycleObservation {
  scenario: LifecycleScenario;
  expected: string;
  original: string;
  previousPrefix: string;
  beforeReload: string;
  reloaded: string;
  messages: Array<{
    id: string;
    parentId: string;
    text: string;
    assistant: boolean;
    unfinished: boolean;
    error: boolean;
  }>;
  callsBeforeReload: number;
  callsAfterReload: number;
  cancellation?: {
    acknowledged: boolean;
    providerClosed: boolean;
    providerFinished: boolean;
    lateCompletionRejected: boolean;
  };
  failure?: { saved: boolean; visibleAfterReload: boolean };
}
/** Evaluate in-memory observations; returns only fixed check names and allowlisted numeric evidence. */
export function evaluateLifecycle(
  observation: LifecycleObservation,
): ExternalObservation;

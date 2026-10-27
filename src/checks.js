// Raw observations remain in memory. Returned evidence is deliberately allowlisted.
export const LIFECYCLE_SCENARIOS = Object.freeze([
  'persistence',
  'cancellation',
  'regeneration',
  'error-retry',
]);
export function evaluateLifecycle(o) {
  const text = (v) => typeof v === 'string' && v.length > 0;
  const bool = (v) => typeof v === 'boolean';
  if (
    !o ||
    !LIFECYCLE_SCENARIOS.includes(o.scenario) ||
    !text(o.expected) ||
    !text(o.original) ||
    !text(o.previousPrefix) ||
    typeof o.beforeReload !== 'string' ||
    typeof o.reloaded !== 'string' ||
    !Array.isArray(o.messages) ||
    o.messages.some(
      (m) =>
        !m ||
        !text(m.id) ||
        typeof m.parentId !== 'string' ||
        typeof m.text !== 'string' ||
        !bool(m.assistant) ||
        !bool(m.unfinished) ||
        !bool(m.error),
    ) ||
    !Number.isSafeInteger(o.callsBeforeReload) ||
    o.callsBeforeReload < 1 ||
    !Number.isSafeInteger(o.callsAfterReload) ||
    o.callsAfterReload < 0
  )
    throw new Error('Invalid lifecycle observation');
  const checks = [];
  const check = (name, passed) => checks.push({ name, passed });
  const matching = o.messages.filter(
    (m) => m.assistant && m.text.trim() === o.expected.trim(),
  );
  check('saved.answer-present', matching.length > 0);
  check('saved.single-matching-answer', matching.length === 1);
  check('ui.answer-visible', o.beforeReload.includes(o.expected));
  check(
    'saved.lifecycle-state',
    matching.length === 1 &&
      (o.scenario === 'cancellation'
        ? matching[0].unfinished === true
        : matching[0].unfinished === false && !matching[0].error),
  );
  check('reload.answer-preserved', o.reloaded.includes(o.expected));
  check('reload.no-new-generation', o.callsAfterReload === o.callsBeforeReload);
  if (o.scenario === 'cancellation') {
    const c = o.cancellation;
    if (
      !c ||
      [
        'acknowledged',
        'providerClosed',
        'providerFinished',
        'lateCompletionRejected',
      ].some((k) => !bool(c[k]))
    )
      throw new Error('Invalid cancellation observation');
    check('cancel.server-acknowledged', c.acknowledged);
    check('cancel.provider-aborted', c.providerClosed && !c.providerFinished);
    check('cancel.late-completion-rejected', c.lateCompletionRejected);
  }
  if (o.scenario === 'regeneration') {
    const original = o.messages.filter(
      (m) => m.assistant && m.text === o.original,
    );
    check('retry.original-branch-preserved', original.length === 1);
    check(
      'retry.distinct-sibling',
      original.length === 1 &&
        matching.length === 1 &&
        original[0].id !== matching[0].id &&
        original[0].parentId === matching[0].parentId,
    );
  }
  if (o.scenario === 'error-retry') {
    const f = o.failure;
    if (!f || !bool(f.saved) || !bool(f.visibleAfterReload))
      throw new Error('Invalid failure observation');
    check('error.saved-before-retry', f.saved);
    check('error.visible-after-reload', f.visibleAfterReload);
  }
  if (['regeneration', 'error-retry'].includes(o.scenario))
    check(
      'retry.previous-answer-not-active',
      !o.reloaded.includes(o.previousPrefix),
    );
  return {
    checks,
    evidence: {
      policy: 'summary-only-v1',
      checkVersion: 1,
      savedMessageCount: o.messages.length,
      matchingAnswerCount: matching.length,
      providerCallsBeforeReload: o.callsBeforeReload,
      providerCallsAfterReload: o.callsAfterReload,
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLifecycle } from '../src/checks.js';
import { runVerification } from '../src/index.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const secret = 'PRIVATE_CHAT sk-secret-token person@example.com';
const observation = (scenario = 'persistence') => ({
  scenario,
  expected: secret,
  original: 'old answer',
  previousPrefix: 'old',
  beforeReload: secret,
  reloaded: secret,
  messages: [
    {
      id: 'private-message',
      parentId: 'private-parent',
      text: secret,
      assistant: true,
      unfinished: false,
      error: false,
    },
  ],
  callsBeforeReload: 1,
  callsAfterReload: 1,
});
test('lifecycle checks catch persistence, duplicates, reload calls and state mismatches', () => {
  assert.ok(evaluateLifecycle(observation()).checks.every((c) => c.passed));
  for (const mutate of [
    (o) => (o.messages = []),
    (o) => o.messages.push({ ...o.messages[0] }),
    (o) => (o.reloaded = ''),
    (o) => o.callsAfterReload++,
    (o) => (o.messages[0].unfinished = true),
  ]) {
    const o = observation();
    mutate(o);
    assert.ok(evaluateLifecycle(o).checks.some((c) => !c.passed));
  }
});
test('Stop, regeneration and retry use distinct reusable invariants', () => {
  const stop = observation('cancellation');
  stop.messages[0].unfinished = true;
  stop.cancellation = {
    acknowledged: true,
    providerClosed: true,
    providerFinished: false,
    lateCompletionRejected: true,
  };
  assert.ok(evaluateLifecycle(stop).checks.every((c) => c.passed));
  stop.cancellation.providerFinished = true;
  assert.equal(
    evaluateLifecycle(stop).checks.find(
      (c) => c.name === 'cancel.provider-aborted',
    ).passed,
    false,
  );
  const branch = observation('regeneration');
  branch.messages.push({
    ...branch.messages[0],
    id: 'old-id',
    text: 'old answer',
  });
  assert.ok(evaluateLifecycle(branch).checks.every((c) => c.passed));
  branch.messages[1].parentId = 'different';
  assert.equal(
    evaluateLifecycle(branch).checks.find(
      (c) => c.name === 'retry.distinct-sibling',
    ).passed,
    false,
  );
  const retry = observation('error-retry');
  retry.failure = { saved: true, visibleAfterReload: true };
  assert.ok(evaluateLifecycle(retry).checks.every((c) => c.passed));
  retry.failure.saved = false;
  assert.equal(
    evaluateLifecycle(retry).checks.find(
      (c) => c.name === 'error.saved-before-retry',
    ).passed,
    false,
  );
});
test('missing and nonboolean observations cannot pass', () => {
  for (const mutate of [
    (o) => delete o.messages,
    (o) => (o.messages[0].unfinished = 'false'),
    (o) => (o.expected = ''),
    (o) => (o.scenario = 'unknown'),
    (o) => (o.callsAfterReload = NaN),
  ]) {
    const o = observation();
    mutate(o);
    assert.throws(() => evaluateLifecycle(o), /Invalid/);
  }
  assert.throws(
    () => evaluateLifecycle(observation('cancellation')),
    /Invalid cancellation/,
  );
});
test('raw evidence and unknown fields never reach any report format, including failed checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'streamtrust-safe-'));
  try {
    const o = observation();
    o.reloaded = '';
    o.secret = secret;
    await writeFile(join(dir, 'persistence-1.png'), 'private screenshot');
    const report = await runVerification(
      {
        name: 'test',
        scenarios: ['persistence'],
        metadata: async () => ({ evidencePolicy: 'summary-only-v1' }),
        run: async () => evaluateLifecycle(o),
        close: async () => {},
      },
      dir,
      1,
    );
    assert.equal(report.exitCode, 1);
    for (const file of [
      'report.json',
      'index.html',
      'report.md',
      'junit.xml',
    ]) {
      const text = await readFile(join(dir, file), 'utf8');
      for (const forbidden of [
        secret,
        'private-message',
        'private-parent',
        'person@example.com',
        'sk-secret-token',
      ])
        assert.ok(!text.includes(forbidden), file);
    }
    assert.equal(report.results[0].evidence.matchingAnswerCount, 1);
    assert.ok(
      !(await readFile(join(dir, 'index.html'), 'utf8')).includes('<img'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyExternal, runVerification } from '../src/index.js';
const observation = {
  checks: [{ name: 'durable', passed: true }],
  evidence: {},
};
test('boolean checks are strict and empty or conflicting observations cannot pass', () => {
  for (const value of [
    null,
    {},
    { checks: [] },
    { checks: [{ name: 'durable', passed: 'false' }] },
    {
      checks: [
        { name: 'durable', passed: true },
        { name: 'durable', passed: true },
      ],
    },
    { ...observation, unsupported: 'not supported' },
  ])
    assert.equal(classifyExternal(value), 'HARNESS_ERROR');
  assert.equal(
    classifyExternal({ ...observation, classification: 'FAIL' }),
    'PASS',
  );
  assert.equal(
    classifyExternal({ checks: [], unsupported: 'No contract', evidence: {} }),
    'UNSUPPORTED',
  );
});
test('adapter cannot override the calculated result and cleanup failures fail the suite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'streamtrust-core-'));
  try {
    const report = await runVerification(
      {
        name: 'control',
        scenarios: ['a'],
        metadata: async () => ({}),
        run: async () => ({
          ...observation,
          checks: [{ name: 'durable', passed: false }],
          classification: 'PASS',
          scenario: 'spoof',
        }),
        close: async () => {
          throw new Error('Cleanup failed');
        },
      },
      dir,
      1,
    );
    assert.equal(report.results[0].classification, 'FAIL');
    assert.equal(report.results[0].scenario, 'a');
    assert.equal(report.exitCode, 2);
    assert.match(
      await readFile(join(dir, 'junit.xml'), 'utf8'),
      /failures="1" errors="1"/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('invalid scenario matrices and repetition counts cannot produce success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'streamtrust-matrix-'));
  try {
    for (const [scenarios, repetitions] of [
      [[], 3],
      [['a', 'a'], 1],
      [['../a'], 1],
      [['a'], 0],
      [['a'], NaN],
    ]) {
      const report = await runVerification(
        {
          name: 'control',
          scenarios,
          metadata: async () => ({}),
          run: async () => observation,
          close: async () => {},
        },
        dir,
        repetitions,
      );
      assert.equal(report.exitCode, 2);
      assert.equal(report.results.length, 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

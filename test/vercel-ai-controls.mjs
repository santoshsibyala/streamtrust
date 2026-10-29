// Run only against a disposable generated reference app, never a team's application.
// Usage: node test/vercel-ai-controls.mjs /path/to/clean-consumer
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const consumer = resolve(process.argv[2]);
const preset = join(consumer, process.argv[3] || 'integration');
const root = join(preset, 'reference-app');
const route = join(root, 'app/api/chat/route.js');
const original = await readFile(route, 'utf8');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'streamtrust-vercel-ai-reference-app');
assert.equal(pkg.private, true);
const cli = join(consumer, 'node_modules/streamtrust/bin/streamtrust.js');
const wrapper = join(preset, 'control.mjs');
function build() {
  const p = spawnSync(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'build'], {
    cwd: root, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', timeout: 180000,
  });
  assert.equal(p.status, 0, p.stderr || p.stdout);
}
const controls = [
  ['cancel-disconnected', 'cancellation', 'abortSignal: req.signal,', '', 'cancel.provider-aborted'],
  ['branch-overwritten', 'regeneration', "parentId = leaf.role === 'assistant' ? leaf.parentId : leaf.id;", "parentId = leaf.role === 'assistant' ? leaf.parentId : leaf.id;\n    chat.messages = chat.messages.filter((m) => m.id !== leaf.id);", 'retry.original-branch-preserved'],
  ['failure-not-saved', 'error-retry', 'async onEnd({ responseMessage, outcome }) {', "async onEnd({ responseMessage, outcome }) {\n      if (outcome.status !== 'completed') return;", 'error.saved-before-retry'],
];
try {
  for (const [name, scenario, from, to, checkName] of controls) {
    assert.ok(original.includes(from));
    await writeFile(route, original.replace(from, to));
    build();
    await writeFile(wrapper, `import factory from './adapter.mjs';\nexport default async () => { const a = await factory(); a.scenarios = [${JSON.stringify(scenario)}]; return a; };\n`);
    const output = join(consumer, 'reports', name);
    const p = spawnSync(process.execPath, [cli, 'verify', '--adapter', wrapper, '--output', output, '--repetitions', '1', '--timeout-ms', '180000'], {
      cwd: consumer, encoding: 'utf8', timeout: 190000,
    });
    assert.equal(p.status, 1, p.stdout + p.stderr);
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(report.results[0].classification, 'FAIL');
    assert.ok(report.results[0].checks.some((c) => c.name === checkName && c.passed === false));
    console.log(`Detected ${name}: ${checkName} failed (exit 1)`);
  }
} finally {
  await writeFile(route, original);
  await rm(wrapper, { force: true });
  build();
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../bin/streamtrust.js', import.meta.url));
const example = fileURLToPath(
  new URL('../examples/http.adapter.mjs', import.meta.url),
);
function run(args, cwd, env = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    p.stdout.on('data', (x) => (text += x));
    p.stderr.on('data', (x) => (text += x));
    p.on('error', fail);
    p.on('exit', (code, signal) => ok({ code, signal, text }));
  });
}
test('CLI executes network demo and catches deliberate demo persistence loss', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'streamtrust-cli-'));
  try {
    const args = [
      'verify',
      '--adapter',
      example,
      '--output',
      'report',
      '--repetitions',
      '1',
    ];
    assert.equal((await run(args, cwd)).code, 0);
    const initial = JSON.parse(
      await readFile(join(cwd, 'report/report.json'), 'utf8'),
    );
    const failure = await run(args, cwd, {
      STREAMTRUST_DEMO_FAULT: 'drop-save',
    });
    assert.equal(failure.code, 1, failure.text);
    const report = JSON.parse(
      await readFile(join(cwd, 'report/report.json'), 'utf8'),
    );
    assert.notEqual(report.runId, initial.runId);
    assert.equal(report.counts.FAIL, 3);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test('timeouts and early exit replace stale reports with harness errors', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'streamtrust-timeout-'));
  try {
    for (const [name, source] of [
      ['hang', 'export default async()=>{while(true){}}'],
      ['exit', 'export default async()=>process.exit(0)'],
      ['missing', 'export const notAFactory=1'],
    ]) {
      await writeFile(join(cwd, 'adapter.mjs'), source);
      const result = await run(
        [
          'verify',
          '--adapter',
          'adapter.mjs',
          '--output',
          'report',
          '--timeout-ms',
          '500',
        ],
        cwd,
      );
      assert.equal(result.code, 2, `${name}: ${result.text}`);
      const report = JSON.parse(
        await readFile(join(cwd, 'report/report.json'), 'utf8'),
      );
      assert.equal(report.exitCode, 2);
      assert.ok(report.suiteErrors.length);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test('init preserves existing adapter and rejects bad CLI options', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'streamtrust-init-'));
  try {
    assert.equal((await run(['init'], cwd)).code, 0);
    await writeFile(join(cwd, 'streamtrust/adapter.mjs'), 'user content');
    assert.equal((await run(['init'], cwd)).code, 2);
    assert.equal(
      await readFile(join(cwd, 'streamtrust/adapter.mjs'), 'utf8'),
      'user content',
    );
    for (const args of [
      ['verify'],
      ['verify', '--adapter', 'a', '--repetitions', '0'],
      ['verify', '--adapter', 'a', '--mystery', 'x'],
    ])
      assert.equal((await run(args, cwd)).code, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('unsupported scenarios are non-green and setup/cleanup errors remain harness failures', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'streamtrust-status-'));
  try {
    const fixtures = [
      [
        1,
        "export default async()=>({name:'app',scenarios:['cancel'],metadata:async()=>({}),run:async()=>({checks:[],evidence:{},unsupported:'No server stop contract'}),close:async()=>{}})",
      ],
      [
        2,
        "export default async()=>({name:'app',scenarios:['saved'],metadata:async()=>{throw Error('metadata unavailable')},run:async()=>({checks:[{name:'saved',passed:true}],evidence:{}}),close:async()=>{}})",
      ],
      [
        2,
        "export default async()=>({name:'app',scenarios:['saved'],metadata:async()=>({}),run:async()=>({checks:[{name:'saved',passed:true}],evidence:{}}),close:async()=>{throw Error('cleanup failed')}})",
      ],
    ];
    for (const [status, source] of fixtures) {
      await writeFile(join(cwd, 'adapter.mjs'), source);
      const result = await run(
        [
          'verify',
          '--adapter',
          'adapter.mjs',
          '--output',
          'report',
          '--repetitions',
          '1',
        ],
        cwd,
      );
      assert.equal(result.code, status, result.text);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

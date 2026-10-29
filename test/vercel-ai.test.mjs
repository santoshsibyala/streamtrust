import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, cp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertIsolatedCheckout, normalizeAssistant } from '../examples/vercel-ai/config.mjs';

test('Next.js production environment files are rejected before build or startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'streamtrust-env-'));
  try {
    assertIsolatedCheckout(root);
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
      await writeFile(join(root, name), 'PRIVATE_TEST_MARKER=secret');
      assert.throws(() => assertIsolatedCheckout(root), /without environment files/);
      await rm(join(root, name));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown saved states cannot be normalized into a complete answer', () => {
  const m = { id: 'a', parentId: 'u', text: 'answer' };
  for (const status of [undefined, null, 'pending', 'failed', 'COMPLETE'])
    assert.throws(() => normalizeAssistant({ ...m, status }), /Unknown saved/);
  assert.equal(normalizeAssistant({ ...m, status: 'complete' }).unfinished, false);
  assert.equal(normalizeAssistant({ ...m, status: 'aborted' }).unfinished, true);
  assert.equal(normalizeAssistant({ ...m, status: 'error' }).error, true);
});

test('scaffolding copies only declared sources, excluding build and configuration files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'streamtrust-inventory-'));
  try {
    const pkg = join(root, 'pkg');
    await mkdir(pkg);
    for (const name of ['src', 'bin', 'examples', 'package.json'])
      await cp(new URL(`../${name}`, import.meta.url), join(pkg, name), { recursive: true });
    const fixture = join(pkg, 'examples/vercel-ai/reference-app');
    await mkdir(join(fixture, '.next'));
    await writeFile(join(fixture, '.next/BUILD_ID'), 'stale');
    await writeFile(join(fixture, '.env.production.local'), 'secret');
    await writeFile(join(fixture, 'private.json'), 'secret');
    execFileSync(process.execPath, [join(pkg, 'bin/streamtrust.js'), 'init', join(root, 'generated'), '--preset', 'vercel-ai']);
    for (const name of ['.next/BUILD_ID', '.env.production.local', 'private.json'])
      await assert.rejects(readFile(join(root, 'generated/reference-app', name)), { code: 'ENOENT' });
    assert.ok(JSON.parse(await readFile(join(root, 'generated/reference-app/npm-shrinkwrap.json'), 'utf8')).lockfileVersion);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { assertIsolatedCheckout } from './config.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(
  process.env.STREAMTRUST_VERCEL_AI_ROOT ||
    fileURLToPath(new URL('./reference-app', import.meta.url)),
);
if (Number(process.versions.node.split('.')[0]) < 22)
  throw new Error('The vercel-ai preset requires Node.js 22+ (AI SDK 7)');
if (!existsSync(resolve(root, 'package.json')))
  throw new Error(`No package.json in ${root}`);
assertIsolatedCheckout(root);
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
// The bundled shrinkwrap pins the fixture; external checkouts retain their own lockfile.
run('npm', [
  existsSync(resolve(root, 'npm-shrinkwrap.json')) || existsSync(resolve(root, 'package-lock.json')) ? 'ci' : 'install',
  '--no-audit',
  '--no-fund',
]);
run('npm', ['run', 'build']);

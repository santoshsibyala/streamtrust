import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.env.STREAMTRUST_LIBRECHAT_ROOT;
const pin =
  process.env.STREAMTRUST_LIBRECHAT_COMMIT ||
  'a378657583567310c841d652b0f6b00c83e2bd6b';
if (
  !root ||
  Number(process.versions.node.split('.')[0]) < 24 ||
  !/^[a-f0-9]{40}$/.test(pin)
)
  throw new Error(
    'Set STREAMTRUST_LIBRECHAT_ROOT; use Node 24+ and a full commit SHA',
  );
const path = resolve(root);
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
if (!existsSync(path)) {
  run('git', [
    'clone',
    '--no-checkout',
    'https://github.com/LibreChat-AI/LibreChat.git',
    path,
  ]);
  run('git', ['checkout', '--detach', pin], path);
}
if (
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path,
    encoding: 'utf8',
  }).trim() !== pin ||
  execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: path,
    encoding: 'utf8',
  }).trim()
)
  throw new Error(
    'Checkout must be clean and match the expected commit; setup never resets existing source',
  );
run('npm', ['ci', '--no-audit', '--no-fund'], path);
run('npm', ['run', 'frontend'], path);

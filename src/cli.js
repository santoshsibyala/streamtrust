import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, copyFile, open, unlink, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { VERSION, failureReport } from './index.js';
const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));
// Explicit source inventory: never copy local builds, dependencies or configuration.
const PRESETS = {
  http: [['http.adapter.mjs', 'adapter.mjs'], ['demo-app.mjs', 'demo-app.mjs']],
  librechat: ['adapter.mjs', 'provider.mjs', 'setup.mjs', 'README.md'].map(
    (name) => [`librechat/${name}`, name]),
  'vercel-ai': [
    'adapter.mjs', 'provider.mjs', 'setup.mjs', 'config.mjs', 'README.md',
    'reference-app/package.json', 'reference-app/npm-shrinkwrap.json',
    'reference-app/next.config.mjs', 'reference-app/lib/store.js',
    'reference-app/app/layout.jsx', 'reference-app/app/page.jsx',
    'reference-app/app/api/chat/route.js', 'reference-app/app/chat/[id]/chat.jsx',
    'reference-app/app/chat/[id]/page.jsx',
  ].map((name) => [`vercel-ai/${name}`, name]),
};
export function presets() { return Object.keys(PRESETS); }
function presetFiles(preset) { return PRESETS[preset]; }
const HELP = () =>
  `StreamTrust ${VERSION}\n\nUsage:\n  streamtrust init [directory] [--preset <name>]\n  streamtrust verify --adapter ./streamtrust/adapter.mjs [options]\n\nOptions:\n  --output <directory>    Reports (default: reports/streamtrust)\n  --repetitions <1-1000>   Repetitions per scenario (default: 3)\n  --timeout-ms <integer>  Total run deadline including setup/cleanup (default: 300000)\n  --help                 Show help\n  --version              Show version\n\nPresets: ${presets().join(', ')} (default: http)\n\nExit codes: 0 all pass; 1 failed/unsupported checks; 2 setup, timeout or harness error.\nAdapters execute trusted local code. JavaScript ESM (.mjs) works without dependencies.\n`;
export async function main(args) {
  let outputDir;
  try {
    if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
      console.log(VERSION);
      return 0;
    }
    if (!args.length || args.includes('--help')) {
      console.log(HELP());
      return 0;
    }
    if (args[0] === 'init') {
      const initArgs = args.slice(1);
      const presetIndex = initArgs.indexOf('--preset');
      let preset = 'http';
      if (presetIndex !== -1) {
        preset = initArgs[presetIndex + 1];
        initArgs.splice(presetIndex, 2);
        if (!presets().includes(preset))
          throw new Error(
            `Unknown init preset; available: ${presets().join(', ')}`,
          );
      }
      if (initArgs.length > 1 || initArgs[0]?.startsWith('-'))
        throw new Error('Invalid init arguments');
      const dir = resolve(initArgs[0] ?? 'streamtrust');
      await mkdir(dir, { recursive: true });
      // Exclusive copies preserve existing adapters. No generated config overrides user files.
      const created = [];
      try {
        for (const [source, target] of presetFiles(preset)) {
          const destination = resolve(dir, target);
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(
            join(EXAMPLES, source),
            destination,
            constants.COPYFILE_EXCL,
          );
          created.push(destination);
        }
      } catch (error) {
        await Promise.all(created.map((path) => unlink(path)));
        throw error;
      }
      console.log(
        `Created ${dir}\nRun: streamtrust verify --adapter ${JSON.stringify(resolve(dir, 'adapter.mjs'))}`,
      );
      return 0;
    }
    if (args[0] !== 'verify') throw new Error(`Unknown command: ${args[0]}`);
    const values = new Map();
    const known = new Set([
      '--adapter',
      '--output',
      '--repetitions',
      '--timeout-ms',
    ]);
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i],
        value = args[i + 1];
      if (
        !known.has(key) ||
        values.has(key) ||
        !value ||
        value.startsWith('--')
      )
        throw new Error(`Invalid or duplicate option: ${key}`);
      values.set(key, value);
    }
    if (!values.has('--adapter')) throw new Error('--adapter is required');
    const repetitions = Number(values.get('--repetitions') ?? 3),
      timeout = Number(values.get('--timeout-ms') ?? 300000);
    if (
      !Number.isSafeInteger(repetitions) ||
      repetitions < 1 ||
      repetitions > 1000
    )
      throw new Error('--repetitions must be 1–1000');
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 86400000)
      throw new Error('--timeout-ms must be 100–86400000');
    outputDir = resolve(values.get('--output') ?? 'reports/streamtrust');
    await mkdir(outputDir, { recursive: true });
    const lock = resolve(outputDir, '.streamtrust.lock');
    const handle = await open(lock, 'wx').catch((error) => {
      throw new Error(
        `Cannot lock output directory (${error.code}); use a unique directory per CI job. Remove a stale lock only after its process has stopped.`,
      );
    });
    const runId = randomUUID();
    await handle.writeFile(JSON.stringify({ pid: process.pid, runId }));
    await handle.close();
    try {
      const config = {
        adapter: resolve(values.get('--adapter')),
        outputDir,
        repetitions,
        runId,
      };
      const child = fork(
        fileURLToPath(new URL('./worker.js', import.meta.url)),
        [JSON.stringify(config)],
        {
          execArgv: process.execArgv,
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          detached: process.platform !== 'win32',
        },
      );
      const signalChild = (signal) => {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {}
      };
      let terminal, reason, timer, grace;
      const interrupt = () => {
        if (reason) return;
        reason = 'Verifier interrupted';
        signalChild('SIGTERM');
        grace = setTimeout(() => signalChild('SIGKILL'), 1000);
      };
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      timer = setTimeout(() => {
        reason = `Run deadline exceeded (${timeout}ms)`;
        signalChild('SIGTERM');
        grace = setTimeout(() => signalChild('SIGKILL'), 1000);
      }, timeout);
      let exited;
      try {
        child.on('message', (message) => {
          if (message?.type === 'result' && message.runId === runId)
            terminal = message;
        });
        exited = await new Promise((ok, fail) => {
          child.once('error', fail);
          child.once('exit', (code, signal) => ok({ code, signal }));
        });
      } finally {
        clearTimeout(timer);
        clearTimeout(grace);
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
        signalChild('SIGKILL');
      }
      if (
        reason ||
        !terminal ||
        ![0, 1, 2].includes(terminal.exitCode) ||
        exited.code !== terminal.exitCode
      ) {
        await failureReport(
          outputDir,
          runId,
          reason ??
            `Adapter process exited without a valid result (${JSON.stringify(exited)})`,
        );
        return 2;
      }
      const report = JSON.parse(
        await readFile(resolve(outputDir, 'report.json'), 'utf8'),
      );
      if (report.runId !== runId || report.exitCode !== terminal.exitCode)
        throw new Error('Report does not match current invocation');
      console.log(
        `StreamTrust: ${JSON.stringify(report.counts)}; exit ${report.exitCode}\nReports: ${outputDir}`,
      );
      return report.exitCode;
    } catch (error) {
      await failureReport(outputDir, runId, error);
      console.error(String(error));
      return 2;
    } finally {
      await unlink(lock);
    }
  } catch (error) {
    console.error(`StreamTrust: ${error.message}`);
    return 2;
  }
}

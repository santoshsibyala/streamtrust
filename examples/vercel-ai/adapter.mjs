import { assertIsolatedCheckout, normalizeAssistant } from './config.mjs';
import { existsSync } from 'node:fs';
import { evaluateLifecycle } from 'streamtrust/checks';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { startProvider } from './provider.mjs';

// Visible text the app renders for a failed generation; change it for your app.
const FAILED = 'The model provider failed.';
const debug = process.env.STREAMTRUST_VERCEL_AI_DEBUG === '1';
export async function until(check, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
let phase = 'preflight';
async function createAdapter() {
  if (Number(process.versions.node.split('.')[0]) < 22)
    throw new Error('vercel-ai preset requires Node.js 22+');
  const root = resolve(
    process.env.STREAMTRUST_VERCEL_AI_ROOT ||
      fileURLToPath(new URL('./reference-app', import.meta.url)),
  );
  assertIsolatedCheckout(root);
  if (!existsSync(resolve(root, '.next/BUILD_ID')))
    throw new Error('App is not built; run setup.mjs first');
  const configPort = Number(process.env.STREAMTRUST_VERCEL_AI_PORT || 0);
  if (!Number.isInteger(configPort) || configPort < 0 || configPort > 65535)
    throw new Error('Invalid app port');
  const port =
    configPort ||
    (await new Promise((ok, fail) => {
      const server = createServer();
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        const value = server.address().port;
        server.close(() => ok(value));
      });
    }));
  const baseUrl = `http://127.0.0.1:${port}`;
  const require = createRequire(resolve(process.cwd(), 'package.json'));
  const { chromium } = require('playwright');
  const appRequire = createRequire(resolve(root, 'package.json'));
  const lockPath = ['npm-shrinkwrap.json', 'package-lock.json'].map((name) => resolve(root, name)).find(existsSync);
  const versions = Object.fromEntries(
    ['ai', 'next', '@ai-sdk/react'].map((name) => {
      try {
        return [name, appRequire(`${name}/package.json`).version];
      } catch {
        return [name, 'unknown'];
      }
    }),
  );
  const cleanups = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    let cleanupFailed = false;
    for (const close of cleanups.reverse()) {
      try {
        await close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new Error('Vercel AI preset cleanup failed');
  };
  try {
    const provider = await startProvider();
    cleanups.push(() => provider.close());
    phase = 'disposable store';
    const store = await mkdtemp(join(tmpdir(), 'streamtrust-vercel-ai-'));
    cleanups.unshift(() => rm(store, { recursive: true, force: true }));
    const runtime = process.execPath;
    const env = {
      // Do not forward provider keys, database URLs or application secrets.
      ...Object.fromEntries(
        ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot']
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      ),
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      CHAT_STORE_DIR: store,
      MODEL_BASE_URL: provider.url,
      MODEL_API_KEY: 'fixture-not-a-real-key',
      MODEL_NAME: 'fixture-model',
    };
    phase = 'application startup';
    const app = spawn(
      runtime,
      [
        appRequire.resolve('next/dist/bin/next'),
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: root,
        env,
        stdio: ['ignore', 'ignore', debug ? 'inherit' : 'ignore'],
      },
    );
    let appError = false;
    app.on('error', () => {
      appError = true;
    });
    cleanups.push(async () => {
      if (!appError && app.exitCode === null && app.signalCode === null) {
        const stopped = new Promise((r) => app.once('exit', () => r()));
        app.kill('SIGTERM');
        const timer = setTimeout(() => app.kill('SIGKILL'), 10000);
        await stopped;
        clearTimeout(timer);
      }
    });
    phase = 'browser startup';
    const browser = await chromium.launch(
      !process.env.STREAMTRUST_BROWSER_CHANNEL
        ? { headless: true }
        : { channel: process.env.STREAMTRUST_BROWSER_CHANNEL, headless: true },
    );
    cleanups.push(() => browser.close());
    phase = 'application readiness';
    await until(
      async () => {
        if (appError || app.exitCode !== null)
          throw new Error('App startup failed; check the build and port');
        try {
          return (await fetch(baseUrl, { signal: AbortSignal.timeout(2000) }))
            .ok;
        } catch {
          return false;
        }
      },
      'app ready',
      60000,
    );
    const context = await browser.newContext();
    // Authoritative read. For your app, replace this with a query against its database.
    async function saved(id) {
      try {
        return JSON.parse(await readFile(join(store, `${id}.json`), 'utf8'))
          .messages;
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    }
    const assistants = async (id) =>
      (await saved(id)).filter((m) => m.role === 'assistant');
    const observed = async (check) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    const visible = (p) => p.getByTestId('messages').innerText();
    const stopButton = (p) =>
      p.getByRole('button', { name: 'Stop', exact: true });
    const settled = (p, label) =>
      until(async () => !(await stopButton(p).count()), label);
    const reload = async (p) => {
      await p.reload();
      await p.getByRole('textbox', { name: 'Message' }).waitFor();
    };
    async function waitGeneration(p, index) {
      await until(
        () => provider.generations.length > index,
        'provider request',
      );
      const g = provider.generations[index];
      await until(
        async () => (await visible(p)).includes(g.prefix),
        'first rendered chunk',
      );
      return g;
    }
    return {
      name: 'Vercel AI SDK reference app',
      scenarios: ['persistence', 'cancellation', 'regeneration', 'error-retry'],
      async metadata() {
        return {
          evidencePolicy: 'summary-only-v1',
          checkVersion: 1,
          app: process.env.STREAMTRUST_VERCEL_AI_ROOT
            ? 'configured application'
            : 'bundled reference app',
          versions,
          node: process.version,
          browser: browser.version(),
          lockSha256: lockPath
            ? createHash('sha256')
                .update(await readFile(lockPath))
                .digest('hex')
            : 'none',
          scope:
            'Real Next.js production server, useChat UI, AI SDK route and the app-owned store. Only the OpenAI-compatible model responses are synthetic. Single server process; no multi-instance, resumable-stream, server-crash or production coverage. Stop is a client fetch abort: there is no server stop endpoint, so acknowledgement means the server persisted the aborted state.',
        };
      },
      async run(scenario, { repetition }) {
        const p = await context.newPage();
        let first;
        let second;
        try {
          const id = randomUUID();
          await p.goto(`${baseUrl}/chat/${id}`);
          const input = p.getByRole('textbox', { name: 'Message' });
          await input.waitFor();
          const before = provider.generations.length;
          await input.fill(
            `StreamTrust ${scenario} ${repetition}. Write two sentences.`,
          );
          await input.press('Enter');
          first = await waitGeneration(p, before);
          const cancellation = {};
          const failure = {};
          let expected = first.prefix + first.suffix;
          if (scenario === 'cancellation') {
            await stopButton(p).click();
            await observed(() => first.closed);
            expected = first.prefix;
            cancellation.acknowledged = await observed(async () =>
              (await assistants(id)).some((m) => m.status === 'aborted'),
            );
            cancellation.providerClosed = first.closed;
            cancellation.providerFinished = first.finished;
            cancellation.lateCompletionRejected = !provider.finish(first);
          } else if (scenario === 'error-retry') {
            provider.fail(first);
          } else provider.finish(first);
          await settled(p, 'generation settles');
          if (scenario === 'error-retry') {
            failure.saved = await observed(async () =>
              (await assistants(id)).some((m) => m.status === 'error'),
            );
            await reload(p);
            failure.visibleAfterReload = await observed(async () =>
              (await visible(p)).includes(FAILED),
            );
          }
          if (scenario === 'regeneration' || scenario === 'error-retry') {
            const nextIndex = provider.generations.length;
            await p
              .getByRole('button', { name: 'Regenerate', exact: true })
              .click();
            second = await waitGeneration(p, nextIndex);
            provider.finish(second);
            expected = second.prefix + second.suffix;
            await settled(p, 'retry settles');
          }
          await observed(async () =>
            (await assistants(id)).some(
              (m) =>
                m.text.trim() === expected.trim() && m.status !== 'streaming',
            ),
          );
          const durable = await assistants(id);
          const beforeReload = await visible(p);
          const callsBeforeReload = provider.generations.length;
          await reload(p);
          await observed(async () => (await visible(p)).includes(expected));
          const reloaded = await visible(p);
          return evaluateLifecycle({
            scenario,
            expected,
            original: first.prefix + first.suffix,
            previousPrefix: first.prefix,
            beforeReload,
            reloaded,
            messages: durable.map(normalizeAssistant),
            callsBeforeReload,
            callsAfterReload: provider.generations.length,
            cancellation:
              scenario === 'cancellation' ? cancellation : undefined,
            failure: scenario === 'error-retry' ? failure : undefined,
          });
        } finally {
          if (first && !first.closed) provider.finish(first);
          if (second && !second.closed) provider.finish(second);
          await p.close();
        }
      },
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// Browser/app exceptions can contain prompts, URLs and file paths; reports get fixed messages.
// STREAMTRUST_VERCEL_AI_DEBUG=1 prints raw errors and app stderr to the console, never to reports.
const withheld = (message) => (error) => {
  if (debug) console.error(error);
  throw new Error(message);
};
export default async function safeFactory() {
  phase = 'preflight';
  const adapter = await createAdapter().catch((error) =>
    withheld(
      `Vercel AI preset setup failed during ${phase}. Check Node 22+, Playwright, a built app without .env files, and the port. Raw details withheld.`,
    )(error),
  );
  const run = adapter.run.bind(adapter);
  adapter.run = (...args) =>
    run(...args).catch(
      withheld(
        'Vercel AI scenario could not complete (details withheld by summary-only policy)',
      ),
    );
  const metadata = adapter.metadata.bind(adapter);
  adapter.metadata = () =>
    metadata().catch(
      withheld('Vercel AI metadata unavailable (details withheld)'),
    );
  return adapter;
}

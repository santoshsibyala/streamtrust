import { existsSync } from 'node:fs';
import { evaluateLifecycle } from 'streamtrust/checks';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { startProvider } from './provider.mjs';

const PIN = 'a378657583567310c841d652b0f6b00c83e2bd6b';
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
  if (!process.env.STREAMTRUST_LIBRECHAT_ROOT)
    throw new Error(
      'Set STREAMTRUST_LIBRECHAT_ROOT to a built LibreChat checkout',
    );
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('LibreChat preset requires Node.js 24+');
  const root = resolve(process.env.STREAMTRUST_LIBRECHAT_ROOT);
  if (
    ['.env', '.env.local', '.env.production'].some((name) =>
      existsSync(resolve(root, name)),
    )
  )
    throw new Error('Use an isolated checkout without environment files');
  const expectedCommit = process.env.STREAMTRUST_LIBRECHAT_COMMIT || PIN;
  if (!/^[a-f0-9]{40}$/.test(expectedCommit))
    throw new Error('Expected commit must be a full Git SHA');
  const configPort = Number(process.env.STREAMTRUST_LIBRECHAT_PORT || 0);
  if (!Number.isInteger(configPort) || configPort < 0 || configPort > 65535)
    throw new Error('Invalid LibreChat port');
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
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const dirty = () =>
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  if (commit !== expectedCommit || dirty())
    throw new Error('Expected clean pinned LibreChat checkout');
  const require = createRequire(resolve(process.cwd(), 'package.json'));
  const { chromium } = require('playwright');
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const { MongoClient } = require('mongodb');
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
    if (cleanupFailed) throw new Error('LibreChat cleanup failed');
  };
  try {
    phase = 'disposable database startup';
    const mongo = await MongoMemoryServer.create({
      instance: { ip: '127.0.0.1', dbName: 'streamtrust' },
    });
    cleanups.push(() => mongo.stop());
    const client = new MongoClient(mongo.getUri());
    cleanups.push(() => client.close());
    await client.connect();
    const db = client.db('streamtrust');
    const provider = await startProvider();
    cleanups.push(() => provider.close());
    const temporary = await mkdtemp(
      resolve(tmpdir(), 'streamtrust-librechat-'),
    );
    cleanups.unshift(() => rm(temporary, { recursive: true, force: true }));
    const config = resolve(temporary, 'librechat.yaml');
    await writeFile(
      config,
      `version: 1.3.11\ncache: true\nendpoints:\n  custom:\n    - name: StreamTrust Fixture\n      apiKey: fixture-not-a-real-key\n      baseURL: ${provider.url}\n      models:\n        default: [fixture-model]\n        fetch: false\n      titleConvo: false\n      modelDisplayLabel: Fixture\n`,
    );
    const runtime = process.execPath;
    const env = {
      // Do not forward provider keys, database URLs or application secrets.
      ...Object.fromEntries(
        ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot']
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      ),
      PATH: `${dirname(runtime)}:${process.env.PATH}`,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      DOMAIN_CLIENT: baseUrl,
      DOMAIN_SERVER: baseUrl,
      MONGO_URI: mongo.getUri('streamtrust'),
      CONFIG_PATH: config,
      ENDPOINTS: 'custom',
      OPENAI_API_KEY: '',
      SEARCH: 'false',
      NO_INDEX: 'true',
      ALLOW_REGISTRATION: 'true',
      ALLOW_SOCIAL_LOGIN: 'false',
      ALLOW_EMAIL_LOGIN: 'true',
      JWT_SECRET: randomBytes(32).toString('hex'),
      JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
      CREDS_KEY: randomBytes(32).toString('hex'),
      CREDS_IV: randomBytes(16).toString('hex'),
      SCHEDULES_SINGLE_PROCESS: 'true',
      USE_REDIS: 'false',
      USE_REDIS_STREAMS: 'false',
      REGISTER_MAX: '100',
      LOGIN_MAX: '100',
    };
    phase = 'application startup';
    const app = spawn(runtime, ['api/server/index.js'], {
      cwd: root,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
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
          throw new Error(
            'LibreChat startup failed; check the build and port configuration',
          );
        try {
          return (await fetch(baseUrl, { signal: AbortSignal.timeout(2000) }))
            .ok;
        } catch {
          return false;
        }
      },
      'app ready',
      120000,
    );
    phase = 'synthetic user registration';
    const email = `verifier-${Date.now()}@example.com`,
      password = `Fixture-${randomBytes(12).toString('hex')}!`;
    const registration = await browser.newContext();
    const page = await registration.newPage();
    await page.goto(`${baseUrl}/register`);
    await page.getByLabel('Full name').fill('StreamTrust Verifier');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('confirm_password').fill(password);
    await page.getByLabel('Submit registration').click();
    await page.waitForURL('**/login**');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByTestId('login-button').click();
    await page
      .getByRole('textbox', { name: 'Message input' })
      .waitFor({ timeout: 30000 });
    await page.close();
    async function messages(id) {
      return db
        .collection('messages')
        .find(
          { conversationId: id },
          {
            projection: {
              _id: 0,
              messageId: 1,
              parentMessageId: 1,
              conversationId: 1,
              text: 1,
              content: 1,
              isCreatedByUser: 1,
              error: 1,
              unfinished: 1,
            },
          },
        )
        .toArray();
    }
    const textOf = (m) =>
      m.text ||
      (m.content ?? [])
        .filter((p) => p.type === 'text')
        .map((p) =>
          typeof p.text === 'string' ? p.text : (p.text?.value ?? ''),
        )
        .join('');
    const hasError = (m) =>
      (m.content ?? []).some((part) => part.type === 'error');
    const observed = async (check) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    const visible = (p) => p.getByTestId('messages-view').innerText();
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
      name: 'LibreChat',
      scenarios: ['persistence', 'cancellation', 'regeneration', 'error-retry'],
      async metadata() {
        return {
          evidencePolicy: 'summary-only-v1',
          checkVersion: 1,
          mongodb: (await db.admin().command({ buildInfo: 1 })).version,
          upstream: 'https://github.com/LibreChat-AI/LibreChat',
          commit,
          trackedSourceModified: !!dirty(),
          node: execFileSync(runtime, ['--version'], {
            encoding: 'utf8',
          }).trim(),
          browser: browser.version(),
          lockSha256: createHash('sha256')
            .update(await readFile(resolve(root, 'package-lock.json')))
            .digest('hex'),
          scope:
            'Real native UI, authentication, application routes, generation jobs and MongoDB. Only external OpenAI-compatible provider responses are synthetic. Single server, in-memory stream store; no Redis, worker-kill, database-crash or multi-replica coverage. Regeneration is a branch, not overwriting history. No coordinator installed.',
        };
      },
      async run(scenario, { repetition }) {
        const context = registration;
        const p = await context.newPage();
        const network = [];

        p.on('response', (r) => {
          const path = new URL(r.url()).pathname;
          if (path.startsWith('/api/') && /chat|abort|message/.test(path))
            network.push({
              path,
              method: r.request().method(),
              status: r.status(),
            });
        });
        let first;
        let second;
        try {
          await p.goto(`${baseUrl}/c/new`);
          await p.getByRole('textbox', { name: 'Message input' }).waitFor();
          const selector = p
            .getByRole('button', { name: 'Select a model' })
            .first();
          if (
            (await selector.count()) &&
            !(await selector.innerText()).includes('fixture-model')
          ) {
            await selector.click();
            await p
              .getByRole('option', { name: 'StreamTrust Fixture', exact: true })
              .click();
            const model = p.getByRole('option', {
              name: 'fixture-model',
              exact: true,
            });
            if (await model.isVisible().catch(() => false)) await model.click();
          }
          const before = provider.generations.length;
          await p
            .getByRole('textbox', { name: 'Message input' })
            .fill(
              `StreamTrust ${scenario} ${repetition}. Write two sentences.`,
            );
          const admission = p.waitForResponse(
            (r) =>
              r.request().method() === 'POST' &&
              new URL(r.url()).pathname.startsWith('/api/agents/chat') &&
              !r.url().endsWith('/abort'),
          );
          await p
            .getByRole('textbox', { name: 'Message input' })
            .press('Enter');
          first = await waitGeneration(p, before);
          const accepted = await (await admission).json();
          const id = accepted.conversationId;
          if (!id || id === 'new')
            throw new Error('Missing native admission conversation identity');
          const checks = [];
          let expected = first.prefix + first.suffix;
          if (scenario === 'cancellation') {
            await p
              .getByRole('button', { name: 'Stop generating', exact: true })
              .click();
            await observed(() => first.closed);
            expected = first.prefix;
            checks.push({
              name: 'Native server acknowledges Stop',
              passed: await observed(() =>
                network.some(
                  (e) =>
                    e.method === 'POST' &&
                    e.path.endsWith('/abort') &&
                    e.status === 200,
                ),
              ),
            });
            checks.push({
              name: 'Stop aborts upstream HTTP response before completion',
              passed: first.closed && !first.finished,
            });
            checks.push({
              name: 'Late provider completion cannot be delivered',
              passed: !provider.finish(first),
            });
          } else if (scenario === 'error-retry') {
            provider.fail(first);
          } else provider.finish(first);
          await until(
            async () =>
              !(await p
                .getByRole('button', { name: 'Stop generating', exact: true })
                .count()),
            'generation settles',
          );

          if (scenario === 'error-retry') {
            const errorSaved = await observed(async () =>
              (await messages(id)).some(hasError),
            );

            checks.push({
              name: 'Provider failure retained as a native error part',
              passed: errorSaved,
            });
            await p.reload();
            await p.getByRole('textbox', { name: 'Message input' }).waitFor();
            const errorVisible = await observed(async () =>
              (await visible(p)).includes(
                'model provider closed the connection',
              ),
            );
            checks.push({
              name: 'Provider error context survives reload before retry',
              passed: errorVisible,
            });
          }
          if (scenario === 'regeneration' || scenario === 'error-retry') {
            const nextIndex = provider.generations.length;
            await p
              .getByRole('button', { name: 'Regenerate', exact: true })
              .last()
              .click();
            second = await waitGeneration(p, nextIndex);
            provider.finish(second);
            expected = second.prefix + second.suffix;
            await until(
              async () =>
                !(await p
                  .getByRole('button', { name: 'Stop generating', exact: true })
                  .count()),
              'retry settles',
            );
          }
          await observed(async () =>
            (await messages(id)).some(
              (m) => !m.isCreatedByUser && textOf(m).trim() === expected.trim(),
            ),
          );
          const durable = await messages(id);
          const beforeReload = await visible(p);
          await p.reload();
          await p.getByRole('textbox', { name: 'Message input' }).waitFor();
          await observed(async () => (await visible(p)).includes(expected));
          const reloaded = await visible(p);
          return evaluateLifecycle({
            scenario,
            expected,
            original: first.prefix + first.suffix,
            previousPrefix: first.prefix,
            beforeReload,
            reloaded,
            messages: durable
              .filter((m) => !m.isCreatedByUser)
              .map((m) => ({
                id: m.messageId,
                parentId: m.parentMessageId,
                text: textOf(m),
                assistant: !m.isCreatedByUser,
                unfinished: m.unfinished,
                error: !!m.error || hasError(m),
              })),
            callsBeforeReload: second ? second.id : first.id,
            callsAfterReload: provider.generations.length,
            cancellation:
              scenario === 'cancellation'
                ? {
                    acknowledged: checks.find(
                      (c) => c.name === 'Native server acknowledges Stop',
                    ).passed,
                    providerClosed: first.closed,
                    providerFinished: first.finished,
                    lateCompletionRejected: checks.find(
                      (c) =>
                        c.name ===
                        'Late provider completion cannot be delivered',
                    ).passed,
                  }
                : undefined,
            failure:
              scenario === 'error-retry'
                ? {
                    saved: checks.find(
                      (c) =>
                        c.name ===
                        'Provider failure retained as a native error part',
                    ).passed,
                    visibleAfterReload: checks.find(
                      (c) =>
                        c.name ===
                        'Provider error context survives reload before retry',
                    ).passed,
                  }
                : undefined,
          });
        } catch {
          // Browser/DB exceptions can contain prompts, selectors, URLs and credentials.
          throw new Error(
            'LibreChat scenario could not complete (details withheld by summary-only policy)',
          );
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

export default async function safeFactory(context) {
  try {
    phase = 'preflight';
    const adapter = await createAdapter();
    const run = adapter.run.bind(adapter);
    adapter.run = async (...args) => {
      try {
        return await run(...args);
      } catch {
        throw new Error(
          'LibreChat scenario could not complete (details withheld by summary-only policy)',
        );
      }
    };
    const metadata = adapter.metadata.bind(adapter);
    adapter.metadata = async () => {
      try {
        return await metadata();
      } catch {
        throw new Error('LibreChat metadata unavailable (details withheld)');
      }
    };
    return adapter;
  } catch {
    throw new Error(
      `LibreChat setup failed during ${phase}. Check Node 24+, optional dependencies, built clean checkout without .env files, expected commit, and port. Raw details withheld.`,
    );
  }
}

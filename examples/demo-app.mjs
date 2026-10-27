// Local teaching fixture, not a production implementation or evidence of customer impact.
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function startDemo() {
  const directory = await mkdtemp(join(tmpdir(), 'streamtrust-demo-'));
  const live = new Map();
  const load = async (id) =>
    JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'));
  const save = (record) =>
    writeFile(join(directory, `${record.id}.json`), JSON.stringify(record));
  const first = 'The answer begins.';
  const suffix = ' The answer is complete.';
  const emit = (response, event) =>
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  const create = async (parentId) => {
    const record = {
      id: randomUUID(),
      parentId,
      status: 'streaming',
      content: first,
    };
    await save(record);
    live.set(record.id, { record, response: null });
    return record;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method === 'POST' && url.pathname === '/runs') {
        json(await create(null), 201);
        return;
      }
      const id = parts[1];
      if (parts[0] !== 'runs' || !/^[0-9a-f-]{36}$/.test(id ?? '')) {
        json({ error: 'Not found' }, 404);
        return;
      }
      const record = await load(id);
      if (req.method === 'GET' && parts.length === 2) {
        json(record);
        return;
      }
      if (req.method === 'GET' && parts[2] === 'events') {
        if (record.status !== 'streaming') {
          json({ error: 'Already terminal' }, 409);
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        live.get(id).response = res;
        emit(res, { type: 'text', content: record.content });
        return;
      }
      if (req.method === 'POST' && parts[2] === 'retry') {
        json(await create(id), 201);
        return;
      }
      if (req.method === 'POST' && ['complete', 'cancel'].includes(parts[2])) {
        const entry = live.get(id);
        if (record.status !== 'streaming') {
          json({ accepted: false });
          return;
        }
        record.status = parts[2] === 'cancel' ? 'cancelled' : 'completed';
        if (record.status === 'completed') record.content += suffix;
        // Explicit negative control for the package's own tests only.
        if (process.env.STREAMTRUST_DEMO_FAULT !== 'drop-save')
          await save(record);
        if (entry?.response) {
          emit(entry.response, {
            type: 'terminal',
            status: record.status,
            content: record.content,
          });
          entry.response.end();
        }
        json({ accepted: true });
        return;
      }
      json({ error: 'Not found' }, 404);
    } catch (error) {
      json({ error: String(error) }, 500);
    }
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

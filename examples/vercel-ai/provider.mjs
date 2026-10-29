import { createServer } from 'node:http';

export async function startProvider() {
  const generations = [];
  const chunk = (g, delta, finish = null) =>
    g.response.write(
      `data: ${JSON.stringify({ id: `chatcmpl-fixture-${g.id}`, object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { content: delta }, finish_reason: finish }] })}\n\n`,
    );
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    if (req.method !== 'POST') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ data: [{ id: 'fixture-model', object: 'model' }] }),
      );
      return;
    }
    const input = JSON.parse(body);
    if (!input.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'Fixture conversation' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
      return;
    }
    const id = generations.length + 1;
    const g = {
      id,
      prefix: `Response ${id} begins.`,
      suffix: ` Response ${id} completes.`,
      closed: false,
      finished: false,
      failed: false,
      path: req.url,
      response: res,
    };
    generations.push(g);
    res.on('close', () => {
      g.closed = true;
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    chunk(g, g.prefix);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    generations,
    finish(g) {
      if (g.closed) return false;
      chunk(g, g.suffix);
      chunk(g, '', 'stop');
      g.finished = true;
      g.response.end('data: [DONE]\n\n');
      return true;
    },
    fail(g) {
      g.failed = true;
      g.response.destroy();
    },
    observations() {
      return generations.map(({ response, ...g }) => g);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

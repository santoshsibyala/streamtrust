import { startDemo } from './demo-app.mjs';

/**
 * @returns {Promise<import('streamtrust').ExternalAppAdapter>}
 * With no URL, starts the bundled local teaching fixture.
 * For your app, replace these route mappings and assertions with its real contracts.
 */
export default async function createAdapter({ signal } = {}) {
  const demo = process.env.STREAMTRUST_BASE_URL ? undefined : await startDemo();
  const baseUrl = process.env.STREAMTRUST_BASE_URL || demo.baseUrl;
  const headers = process.env.STREAMTRUST_API_TOKEN
    ? { authorization: `Bearer ${process.env.STREAMTRUST_API_TOKEN}` }
    : {};
  const requestSignal = () =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000);
  async function json(path, method = 'GET') {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      signal: requestSignal(),
    });
    if (!response.ok)
      throw new Error(`${method} ${path} returned ${response.status}`);
    return response.json();
  }
  async function watch(id) {
    const response = await fetch(new URL(`/runs/${id}/events`, baseUrl), {
      headers,
      signal: requestSignal(),
    });
    if (!response.ok || !response.body)
      throw new Error('Expected SSE response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function next() {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (data) return JSON.parse(data);
          continue;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error('Stream ended before the expected event');
        buffer += decoder.decode(value, { stream: true });
      }
    }
    return { next, close: () => reader.cancel() };
  }
  async function complete(id) {
    const stream = await watch(id);
    try {
      const first = await stream.next();
      await json(`/runs/${id}/complete`, 'POST');
      const terminal = await stream.next();
      return { first, terminal, durable: await json(`/runs/${id}`) };
    } finally {
      await stream.close();
    }
  }
  return {
    name: demo
      ? 'Local HTTP/SSE demonstration'
      : 'Your application HTTP adapter',
    scenarios: ['persistence', 'cancellation', 'retry'],
    async metadata() {
      return {
        mode: demo
          ? 'synthetic local fixture'
          : 'configured external test service',
        contract: 'examples/http.adapter.mjs',
        scope:
          'HTTP/SSE observations and authoritative GET; no browser, database crash, billing, or production coverage',
      };
    },
    async run(scenario) {
      const initial = await json('/runs', 'POST');
      if (scenario === 'cancellation') {
        const stream = await watch(initial.id);
        try {
          const first = await stream.next();
          const cancelled = await json(`/runs/${initial.id}/cancel`, 'POST');
          const terminal = await stream.next();
          const late = await json(`/runs/${initial.id}/complete`, 'POST');
          const durable = await json(`/runs/${initial.id}`);
          return {
            checks: [
              {
                name: 'Server accepts cancellation',
                passed: cancelled.accepted === true,
              },
              {
                name: 'Terminal event and durable state agree on cancellation',
                passed:
                  terminal.status === 'cancelled' &&
                  durable.status === 'cancelled',
              },
              {
                name: 'Partial content remains authoritative',
                passed: durable.content === first.content,
              },
              {
                name: 'Late completion is rejected',
                passed: late.accepted === false,
              },
            ],
            evidence: { first, terminal, durable, late },
          };
        } finally {
          await stream.close();
        }
      }
      const original = await complete(initial.id);
      if (scenario === 'persistence')
        return {
          checks: [
            {
              name: 'Terminal event indicates completed answer',
              passed: original.terminal.status === 'completed',
            },
            {
              name: 'Read after completion matches streamed result',
              passed:
                original.durable.status === 'completed' &&
                original.durable.content === original.terminal.content,
            },
            {
              name: 'Partial text is extended on completion',
              passed:
                original.terminal.content.startsWith(original.first.content) &&
                original.terminal.content.length >
                  original.first.content.length,
            },
          ],
          evidence: original,
        };
      const retry = await json(`/runs/${initial.id}/retry`, 'POST');
      const retried = await complete(retry.id);
      const old = await json(`/runs/${initial.id}`);
      return {
        checks: [
          {
            name: 'Retry has a distinct identity linked to the original',
            passed: retry.id !== initial.id && retry.parentId === initial.id,
          },
          {
            name: 'Original result is unchanged',
            passed: JSON.stringify(old) === JSON.stringify(original.durable),
          },
          {
            name: 'Retried result is durably complete',
            passed:
              retried.durable.status === 'completed' &&
              retried.durable.content === retried.terminal.content,
          },
        ],
        evidence: { original: original.durable, retry: retried.durable },
      };
    },
    async close() {
      await demo?.close();
    },
  };
}

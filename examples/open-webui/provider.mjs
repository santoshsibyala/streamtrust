import { createServer } from "node:http";
export async function startProvider(host, key) {
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + key) {
      res.writeHead(401);
      return res.end();
    }
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") return res.end();
    if (req.url?.endsWith("/models")) {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "gpt-4o-mini", object: "model", owned_by: "local-fixture" },
          ],
        }),
      );
    }
    let raw = "";
    for await (const b of req) raw += b;
    const body = raw ? JSON.parse(raw) : {};
    const id = `fixture-${calls.length + 1}`;
    const call = {
      id,
      path: req.url,
      model: body.model,
      closed: false,
      sentFinish: false,
      res,
      prefix: `Synthetic answer ${calls.length + 1}.`,
      suffix: " Completed.",
    };
    calls.push(call);
    res.on("close", () => {
      call.closed = true;
    });
    if (!body.stream) {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Synthetic title" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    res.flushHeaders();
    call.send = (text) =>
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            { index: 0, delta: { content: text }, finish_reason: null },
          ],
        })}\n\n`,
      );
    call.finish = () => {
      call.sentFinish = true;
      call.send(call.suffix);
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
      res.end();
    };
    call.error = () =>
      res.end(
        'data: {"error":{"message":"Synthetic test interruption"}}\n\ndata: [DONE]\n\n',
      );
  });
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(0, host, ready);
  });
  return {
    port: server.address().port,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
export async function until(fn, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Adapter timeout: ${label}`);
}

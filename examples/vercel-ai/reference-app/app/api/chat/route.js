import { randomUUID } from 'node:crypto';
import { consumeStream, streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { CHAT_ID, activePath, loadChat, saveChat } from '../../../lib/store.js';

export const dynamic = 'force-dynamic';

const provider = createOpenAICompatible({
  name: 'model',
  baseURL: process.env.MODEL_BASE_URL,
  apiKey: process.env.MODEL_API_KEY,
});

const textOf = (message) =>
  (message?.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');

export async function POST(req) {
  const { id, trigger, message } = await req.json();
  if (!CHAT_ID.test(id ?? ''))
    return new Response('Invalid chat id', { status: 400 });
  const chat = (await loadChat(id)) ?? { id, messages: [], activeLeafId: '' };
  let parentId;
  if (trigger === 'regenerate-message') {
    const leaf = chat.messages.find((m) => m.id === chat.activeLeafId);
    if (!leaf) return new Response('Nothing to regenerate', { status: 409 });
    // Keep the previous answer as a sibling instead of overwriting history.
    parentId = leaf.role === 'assistant' ? leaf.parentId : leaf.id;
  } else {
    const text = textOf(message);
    if (!text) return new Response('Empty message', { status: 400 });
    const userId =
      message.id && !chat.messages.some((m) => m.id === message.id)
        ? message.id
        : randomUUID();
    chat.messages.push({
      id: userId,
      parentId: chat.activeLeafId,
      role: 'user',
      text,
      status: 'complete',
    });
    parentId = userId;
  }
  const history = activePath(chat, parentId)
    .filter((m) => m.role === 'user' || m.status === 'complete')
    .map((m) => ({ role: m.role, content: m.text }));
  const assistantId = randomUUID();
  chat.messages.push({
    id: assistantId,
    parentId,
    role: 'assistant',
    text: '',
    status: 'streaming',
  });
  chat.activeLeafId = assistantId;
  await saveChat(chat);

  const result = streamText({
    model: provider.chatModel(process.env.MODEL_NAME || 'fixture-model'),
    messages: history,
    maxRetries: 0,
    // Stop in the browser aborts this request; propagate it to the model call.
    abortSignal: req.signal,
  });
  return result.toUIMessageStreamResponse({
    generateMessageId: () => assistantId,
    onError: () => 'The model provider failed.',
    // Keep consuming after a client disconnect so onEnd still records the outcome.
    consumeSseStream: consumeStream,
    async onEnd({ responseMessage, outcome }) {
      const saved = await loadChat(id);
      const target = saved.messages.find((m) => m.id === assistantId);
      target.text = textOf(responseMessage);
      target.status =
        outcome.status === 'completed'
          ? 'complete'
          : outcome.status === 'aborted'
            ? 'aborted'
            : 'error';
      await saveChat(saved);
    },
  });
}

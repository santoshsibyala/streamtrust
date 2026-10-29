'use client';
import { useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

const FAILED = 'The model provider failed.';

export default function Chat({ id, initialMessages }) {
  const [input, setInput] = useState('');
  const { messages, sendMessage, regenerate, stop, status, error } = useChat({
    id,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/chat',
      // The server owns history; send only the trigger and the newest message.
      prepareSendMessagesRequest: ({ id, messages, trigger }) => ({
        body: { id, trigger, message: messages.at(-1) },
      }),
    }),
  });
  const busy = status === 'submitted' || status === 'streaming';
  const last = messages.at(-1);
  return (
    <main>
      <div data-testid="messages">
        {messages.map((m) => (
          <div key={m.id} data-role={m.role} style={{ margin: '12px 0' }}>
            <strong>{m.role === 'user' ? 'You' : 'Assistant'}: </strong>
            {m.parts
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('')}
            {m.metadata?.status === 'aborted' && <em> (stopped)</em>}
            {m.metadata?.status === 'error' && <p role="alert">{FAILED}</p>}
          </div>
        ))}
        {error && <p role="alert">{FAILED}</p>}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || busy) return;
          sendMessage({ text: input });
          setInput('');
        }}
      >
        <input
          aria-label="Message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={{ width: '70%' }}
        />
        <button type="submit" disabled={busy}>
          Send
        </button>
        {busy && (
          <button type="button" onClick={() => stop()}>
            Stop
          </button>
        )}
        {!busy && (error || last?.role === 'assistant') && (
          <button type="button" onClick={() => regenerate()}>
            Regenerate
          </button>
        )}
      </form>
    </main>
  );
}

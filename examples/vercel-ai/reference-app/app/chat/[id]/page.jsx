import { notFound } from 'next/navigation';
import { CHAT_ID, activePath, loadChat } from '../../../lib/store.js';
import Chat from './chat.jsx';

export const dynamic = 'force-dynamic';

export default async function ChatPage({ params }) {
  const { id } = await params;
  if (!CHAT_ID.test(id)) notFound();
  const chat = await loadChat(id);
  const initialMessages = chat
    ? activePath(chat).map((m) => ({
        id: m.id,
        role: m.role,
        parts: [{ type: 'text', text: m.text }],
        metadata: { status: m.status },
      }))
    : [];
  return <Chat id={id} initialMessages={initialMessages} />;
}

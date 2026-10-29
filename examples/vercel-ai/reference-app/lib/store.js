// File-backed chat store: the reference app's authoritative state.
// Messages are append-only with parent links, so regeneration adds a sibling branch.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CHAT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function dir() {
  if (!process.env.CHAT_STORE_DIR)
    throw new Error('CHAT_STORE_DIR is required');
  return process.env.CHAT_STORE_DIR;
}

export async function loadChat(id) {
  try {
    return JSON.parse(await readFile(join(dir(), `${id}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveChat(chat) {
  await mkdir(dir(), { recursive: true });
  const tmp = join(dir(), `.${chat.id}.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(chat));
  await rename(tmp, join(dir(), `${chat.id}.json`));
}

// The branch currently shown to the user: root → activeLeafId.
export function activePath(chat, leafId = chat.activeLeafId) {
  const byId = new Map(chat.messages.map((m) => [m.id, m]));
  const path = [];
  for (let m = byId.get(leafId); m; m = byId.get(m.parentId)) path.unshift(m);
  return path;
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function assertIsolatedCheckout(root) {
  // Next.js production builds and servers load all four of these files.
  if (['.env', '.env.local', '.env.production', '.env.production.local']
    .some((name) => existsSync(resolve(root, name))))
    throw new Error('Use an app checkout without environment files');
}

export function normalizeAssistant(m) {
  if (!['complete', 'streaming', 'aborted', 'error'].includes(m.status))
    throw new Error('Unknown saved assistant status');
  return { id: m.id, parentId: m.parentId, text: m.text, assistant: true,
    unfinished: m.status === 'aborted' || m.status === 'streaming',
    error: m.status === 'error' };
}

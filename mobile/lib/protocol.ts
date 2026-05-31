'use client';

/**
 * Wire protocol — the TS mirror of the Rust `RemoteMessage` (src-tauri/src/remote/
 * protocol.rs). These are the payloads that live INSIDE the encrypted `{iv, ct}`
 * envelope; the relay only ever sees the ciphertext. Fields are camelCase to match
 * the Rust serde (`sessionId`, `toolsUsed`, `mediaType`).
 *
 *   phone → desktop: `chat`
 *   desktop → phone: `chatResult`, `error`, `presence`
 */

export interface RemoteImage {
  mediaType: string;
  /** base64 (no `data:` prefix). */
  data: string;
}

export interface ChatMessage {
  v: 1;
  id: string;
  type: 'chat';
  text: string;
  provider: string | null;
  model: string | null;
  sessionId: string | null;
  images: RemoteImage[];
}

export interface ChatResultMessage {
  id: string;
  type: 'chatResult';
  text: string;
  toolsUsed: string[];
  images: string[];
}

export interface ErrorMessage {
  id: string;
  type: 'error';
  code: string;
  message: string;
}

export interface PresenceMessage {
  id: string;
  type: 'presence';
  role: string;
  online: boolean;
}

/** Any decrypted frame; unknown `type`s fall through to the catch-all. */
export type RemoteMessage =
  | ChatMessage
  | ChatResultMessage
  | ErrorMessage
  | PresenceMessage
  | { type: string; [k: string]: unknown };

/** A short random correlation id (16 hex chars) — dependency-free. */
export function newId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Build an outbound `chat`. `provider`/`model` default to null (desktop picks). */
export function buildChat(args: {
  id?: string;
  text: string;
  sessionId?: string | null;
  images?: RemoteImage[];
  provider?: string | null;
  model?: string | null;
}): ChatMessage {
  return {
    v: 1,
    id: args.id ?? newId(),
    type: 'chat',
    text: args.text,
    provider: args.provider ?? null,
    model: args.model ?? null,
    sessionId: args.sessionId ?? null,
    images: args.images ?? [],
  };
}

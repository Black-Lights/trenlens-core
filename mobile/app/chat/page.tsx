'use client';

/**
 * The mobile chat timeline (Phase 5).
 *
 * Reads the in-memory paired session (room + AES key + sessionId), opens the
 * authenticated relay socket, and drives the conversation: each send adds a user
 * bubble + a streaming assistant placeholder keyed by the wire `id`; the matching
 * `chatResult` fills it (with the word-chunk reveal), an `error` swaps it for an
 * error bubble. State is page-local — the only cross-route state is the session
 * singleton, set by `/scan`. A hard reload loses the (in-memory) key → back to /scan.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { getAccessToken, onAccessToken } from '@/lib/auth';
import { newId } from '@/lib/protocol';
import { clearRemoteSession, getRemoteSession } from '@/lib/session';
import { RemoteSocket, type SocketStatus } from '@/lib/ws';

import { Composer } from '@/components/Composer';
import { ConnectionPill } from '@/components/ConnectionPill';
import { MessageBubble, type ChatItem } from '@/components/MessageBubble';

export default function ChatPage() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const socketRef = useRef<RemoteSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const session = getRemoteSession();
    if (!session) {
      router.replace('/scan');
      return;
    }
    sessionIdRef.current = session.sessionId;

    let socket: RemoteSocket | null = null;
    let offToken: (() => void) | null = null;
    let disposed = false;

    (async () => {
      const jwt = await getAccessToken();
      if (!jwt) {
        router.replace('/'); // session expired — sign in again
        return;
      }
      if (disposed) return;

      socket = new RemoteSocket({
        jwt,
        room: session.room,
        key: session.key,
        handlers: {
          // On connect, ask the desktop to backfill the shared timeline (§Phase 6).
          onStatus: (s) => {
            setStatus(s);
            if (s === 'connected') void socketRef.current?.requestHistory(sessionIdRef.current);
          },
          // The desktop may join after us; its presence beacon triggers a backfill.
          onPresence: (m) => {
            if (m.online && m.role === 'desktop') void socketRef.current?.requestHistory(sessionIdRef.current);
          },
          // Backfill: adopt the desktop's conversation id (so our next turn lands in
          // the same chat) and render its stored timeline.
          onHistory: (m) => {
            if (m.sessionId) sessionIdRef.current = m.sessionId;
            setMessages(
              m.messages.map((t, i) => ({
                id: `h${i}-${t.role}`,
                role: t.role === 'user' ? ('user' as const) : ('assistant' as const),
                text: t.content,
                streaming: false,
              })),
            );
          },
          // A turn the DESKTOP user typed → show their prompt + the streamed answer.
          onPeerTurn: (m) =>
            setMessages((prev) => [
              ...prev,
              { id: `${m.id}-u`, role: 'user', text: m.userText },
              { id: m.id, role: 'assistant', text: m.text, toolsUsed: m.toolsUsed, images: m.images, streaming: true },
            ]),
          onChatResult: (m) =>
            setMessages((prev) =>
              prev.map((it) =>
                it.id === m.id && it.role === 'assistant'
                  ? { ...it, text: m.text, toolsUsed: m.toolsUsed, images: m.images, streaming: true }
                  : it,
              ),
            ),
          onError: (m) =>
            setMessages((prev) =>
              prev.map((it) =>
                it.id === m.id && it.role === 'assistant'
                  ? { ...it, role: 'error', text: friendlyError(m.code, m.message), streaming: false, code: m.code }
                  : it,
              ),
            ),
        },
      });
      socketRef.current = socket;
      socket.connect();

      // Keep the token fresh on long sockets (push → used on next reconnect).
      offToken = onAccessToken((t) => {
        if (t) socket?.updateToken(t);
      });
    })();

    return () => {
      disposed = true;
      offToken?.();
      socket?.close();
      socketRef.current = null;
    };
  }, [router]);

  // Keep the newest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const handleSend = (text: string) => {
    const id = newId();
    setMessages((prev) => [
      ...prev,
      { id: `${id}-u`, role: 'user', text },
      { id, role: 'assistant', text: '', streaming: true },
    ]);
    socketRef.current
      ?.sendChat({ id, text, sessionId: sessionIdRef.current })
      .catch((e: unknown) =>
        setMessages((prev) =>
          prev.map((it) =>
            it.id === id && it.role === 'assistant'
              ? { ...it, role: 'error', text: e instanceof Error ? e.message : String(e), streaming: false }
              : it,
          ),
        ),
      );
  };

  const handleDisconnect = () => {
    socketRef.current?.close();
    clearRemoteSession();
    router.replace('/');
  };

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="chat-title">TrenLens</div>
        <div className="chat-header-right">
          <ConnectionPill status={status} />
          <button type="button" className="chat-disconnect" onClick={handleDisconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <div className="chat-timeline">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p>Paired with your desktop.</p>
            <p className="chat-empty-sub">Send a message to drive it from here.</p>
          </div>
        ) : (
          messages.map((it) => <MessageBubble key={it.id} item={it} />)
        )}
        <div ref={bottomRef} />
      </div>

      <Composer disabled={status !== 'connected'} onSend={handleSend} />
    </div>
  );
}

/** Turn a wire error into something a person can read. */
function friendlyError(code: string, message: string): string {
  if (code === 'no_key') {
    return 'The desktop has no provider key configured. Add one in the desktop BYOK panel, then try again.';
  }
  return message || 'The desktop could not complete that turn.';
}

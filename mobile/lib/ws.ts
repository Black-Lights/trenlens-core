'use client';

/**
 * Mobile WebSocket transport — the phone half of the blind-relay link.
 *
 * Opens `new WebSocket(relayUrl, [...])` where the four tokens ride as
 * `Sec-WebSocket-Protocol` (browsers can't set custom WS headers, §3.1): the version
 * tag, `auth.<base64url(jwt)>`, `room.<pairingId>`, and `role.mobile`. Every frame is
 * sealed/opened with the Phase-3 AES-GCM codec (crypto.ts) BEFORE it touches the
 * socket, so the relay only ever forwards opaque `{iv, ct}`.
 *
 * Resilience: reconnect with capped exponential backoff; the JWT is re-presented on
 * each reconnect (the relay only checks it at the upgrade), refreshable via
 * `updateToken` before the ~1h expiry. `close()` is intentional (no reconnect).
 */

import { openMessage, sealMessage } from './crypto';
import {
  buildChat,
  buildHistoryRequest,
  type ChatResultMessage,
  type ErrorMessage,
  type HistoryMessage,
  type PeerTurnMessage,
  type PresenceMessage,
  type RemoteImage,
  type RemoteMessage,
} from './protocol';

export type SocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface RemoteHandlers {
  onStatus?: (s: SocketStatus) => void;
  onChatResult?: (m: ChatResultMessage) => void;
  onError?: (m: ErrorMessage) => void;
  onPresence?: (m: PresenceMessage) => void;
  /** Backfill: the desktop's shared timeline + the `sessionId` to adopt (§Phase 6). */
  onHistory?: (m: HistoryMessage) => void;
  /** A turn the DESKTOP user typed, mirrored here so both timelines match (§Phase 6). */
  onPeerTurn?: (m: PeerTurnMessage) => void;
}

const RELAY_SUBPROTOCOL = 'trenlens.relay.v1';
/** Default to the local `wrangler dev` relay; prod sets `wss://<worker>/connect`. */
const DEFAULT_RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL || 'ws://127.0.0.1:8787/connect';
const INITIAL_BACKOFF = 500;
const MAX_BACKOFF = 30_000;

/** utf8 string → unpadded base64url (the JWT is ASCII; header-token safe). */
function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface RemoteSocketOpts {
  jwt: string;
  room: string;
  key: CryptoKey;
  relayUrl?: string;
  handlers?: RemoteHandlers;
}

export class RemoteSocket {
  private ws: WebSocket | null = null;
  private jwt: string;
  private readonly room: string;
  private readonly key: CryptoKey;
  private readonly relayUrl: string;
  private readonly handlers: RemoteHandlers;
  private backoff = INITIAL_BACKOFF;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RemoteSocketOpts) {
    this.jwt = opts.jwt;
    this.room = opts.room;
    this.key = opts.key;
    this.relayUrl = opts.relayUrl ?? DEFAULT_RELAY_URL;
    this.handlers = opts.handlers ?? {};
  }

  /** Open the socket (idempotent: clears any pending reconnect first). */
  connect(): void {
    this.closedByUser = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus('connecting');

    const protocols = [
      RELAY_SUBPROTOCOL,
      `auth.${b64url(this.jwt)}`,
      `room.${this.room}`,
      'role.mobile',
    ];
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.relayUrl, protocols);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = INITIAL_BACKOFF; // a successful handshake resets backoff
      this.setStatus('connected');
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') void this.handleFrame(e.data);
    };
    ws.onerror = () => {
      /* `onclose` always follows — handle reconnect there */
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.closedByUser) {
        this.setStatus('offline');
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Seal + send a `chat` (the phone's only outbound message in v1). */
  async sendChat(args: {
    id?: string;
    text: string;
    sessionId?: string | null;
    images?: RemoteImage[];
  }): Promise<void> {
    await this.send(buildChat(args));
  }

  /** Ask the desktop to backfill the shared timeline (§Phase 6). Sent on connect and
   *  when the desktop announces presence; best-effort (a no-op if not open yet). */
  async requestHistory(sessionId?: string | null): Promise<void> {
    try {
      await this.send(buildHistoryRequest({ sessionId }));
    } catch {
      /* not connected yet — onPresence/onStatus will retry */
    }
  }

  /** Push a refreshed Supabase token; used on the next reconnect. */
  updateToken(jwt: string): void {
    this.jwt = jwt;
  }

  /** Intentional close — no reconnect. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.ws = null;
    this.setStatus('offline');
  }

  private async send(msg: object): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to the desktop.');
    }
    this.ws.send(await sealMessage(this.key, msg));
  }

  private async handleFrame(frame: string): Promise<void> {
    let msg: RemoteMessage;
    try {
      msg = await openMessage<RemoteMessage>(this.key, frame);
    } catch {
      return; // undecryptable / not ours — drop (fail-closed)
    }
    switch (msg.type) {
      case 'chatResult':
        this.handlers.onChatResult?.(msg as ChatResultMessage);
        break;
      case 'error':
        this.handlers.onError?.(msg as ErrorMessage);
        break;
      case 'presence':
        this.handlers.onPresence?.(msg as PresenceMessage);
        break;
      case 'history':
        this.handlers.onHistory?.(msg as HistoryMessage);
        break;
      case 'peerTurn':
        this.handlers.onPeerTurn?.(msg as PeerTurnMessage);
        break;
      default:
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
  }

  private setStatus(s: SocketStatus): void {
    this.handlers.onStatus?.(s);
  }
}

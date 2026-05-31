/** Bindings + vars available to the Worker and the Durable Object (see wrangler.jsonc). */
export interface Env {
  /** Durable Object namespace; one RelayRoom instance per (user_id:pairingId). */
  RELAY_ROOM: DurableObjectNamespace;
  /** Supabase JWKS discovery URL — the relay verifies tokens against this. */
  SUPABASE_JWKS_URL: string;
  /** Expected `iss` claim (Supabase Auth external URL). */
  JWT_ISSUER: string;
  /** Expected `aud` claim (normally "authenticated"). */
  JWT_AUDIENCE: string;
}

/** Which side of the pairing a socket is. */
export type Role = 'desktop' | 'mobile';

/** Per-socket state persisted across DO hibernation via serializeAttachment. */
export interface SocketMeta {
  role: Role;
  connectedAt: number;
}

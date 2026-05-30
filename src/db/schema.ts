/**
 * Local memory schema (single source of truth).
 *
 * This file is consumed by drizzle-kit to GENERATE migration SQL only. It is
 * NOT used to open a connection in the browser/webview. The Rust backend owns
 * the encrypted libsql file and applies these migrations; the frontend reaches
 * the data exclusively through typed Tauri IPC commands (see src/lib/ipc.ts).
 *
 * Columns holding secrets (api_keys.secret_ciphertext) are stored as opaque
 * ciphertext produced by the Rust side — Drizzle/TS never sees plaintext keys.
 */
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const ulid = () => text('id').primaryKey();
const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`);

/** A conversation timeline (the unit rendered by the fluid UI timeline). */
export const conversations = sqliteTable('conversations', {
  id: ulid(),
  title: text('title').notNull().default('Untitled'),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
});

/**
 * Timeline entries. `role` includes 'tool' so tool runs share the timeline.
 * Session partitioning: every message carries a `conversation_id` FK, and the
 * Rust store indexes `(conversation_id, created_at)` so a session reopens in
 * O(rows-in-session). user/assistant turns are persisted by the orchestrator;
 * tool/image turns are stored under role 'tool' as a JSON payload that the
 * timeline replays back into rich entries.
 */
export const messages = sqliteTable('messages', {
  id: ulid(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'tool', 'system'] }).notNull(),
  content: text('content').notNull().default(''),
  createdAt: createdAt(),
});

/** Registered MCP servers the host can route to (stdio | sse | http). */
export const mcpServers = sqliteTable('mcp_servers', {
  id: ulid(),
  name: text('name').notNull(),
  transport: text('transport', { enum: ['stdio', 'sse', 'http'] }).notNull(),
  // stdio: command + args (JSON). sse/http: endpoint URL.
  command: text('command'),
  args: text('args', { mode: 'json' }).$type<string[]>(),
  url: text('url'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
});

/** A single tool invocation — rendered as a Morphing Node on the timeline. */
export const toolRuns = sqliteTable('tool_runs', {
  id: ulid(),
  messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
  serverId: text('server_id').references(() => mcpServers.id),
  toolName: text('tool_name').notNull(),
  args: text('args', { mode: 'json' }),
  result: text('result', { mode: 'json' }),
  status: text('status', { enum: ['pending', 'running', 'done', 'error'] })
    .notNull()
    .default('pending'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
});

/**
 * BYOK configuration. One row per stored provider credential.
 * `secretCiphertext` holds the sealed key (AES-GCM via the Rust crypto layer,
 * §5); a placeholder is stored until that layer lands. Accessed from the
 * frontend through the Drizzle sqlite-proxy adapter (src/lib/db.ts) over IPC.
 */
export const apiKeys = sqliteTable('api_keys', {
  id: ulid(),
  // Free-text so new providers need no migration. Recognised chat providers:
  // anthropic | deepseek | kimi; also: openai | ideogram | openrouter | custom.
  provider: text('provider').notNull(),
  label: text('label').notNull().default(''),
  baseUrl: text('base_url'), // optional custom endpoint (e.g. the local proxy)
  secretCiphertext: text('secret_ciphertext').notNull(),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
});

/** Arbitrary key/value app settings (theme, default models, proxy port…). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }),
});

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
export type ToolRun = typeof toolRuns.$inferSelect;

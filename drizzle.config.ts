import type { Config } from 'drizzle-kit';

/**
 * Drizzle is used here only to author the schema and generate SQL migrations.
 * At runtime the frontend never opens the database directly — all reads/writes
 * are marshalled to the Rust `libsql` crate over Tauri IPC (see
 * RESEARCH_AND_GUIDELINES.md §4). The generated migration SQL is shipped to and
 * applied by the Rust side against the encrypted libsql file.
 */
export default {
  schema: './src/db/schema.ts',
  out: './src-tauri/migrations',
  // Plain SQLite dialect: drizzle-kit emits portable SQLite DDL that the Rust
  // `libsql` crate applies against the encrypted file. We deliberately do NOT
  // set a `driver` (no d1/expo/turso runtime) because migrations are applied by
  // Rust, not by drizzle-kit at runtime.
  dialect: 'sqlite',
} satisfies Config;

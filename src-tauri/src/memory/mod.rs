//! Local memory — SQLite store. **The Rust side is the sole owner of the file.**
//!
//! Implemented on `rusqlite` (`bundled` → SQLite compiled from source). The
//! frontend never opens a connection; it reaches the DB exclusively through the
//! `execute_sql` / `query_sql` IPC bridge (`commands.rs`), over which the custom
//! Drizzle sqlite-proxy adapter (`src/lib/db.ts`) routes its generated SQL.
//!
//! Deviation from §4 (documented in §11): we use rusqlite, not libsql, and the
//! DB file is not yet encrypted at rest. Individual secrets are still sealed at
//! the row level by `crypto/` (§5); SQLCipher (`bundled-sqlcipher`) can add
//! file-level encryption later without changing this surface.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, Connection};
use serde_json::Value;

/// Embedded schema, mirroring `src/db/schema.ts`. Applied idempotently at
/// startup (drizzle-kit may also emit these to `migrations/`, but Rust owns
/// application). Covers BYOK secrets, conversation history (§ history sidebar),
/// and the key/value settings store (persisted model/provider preference).
const MIGRATIONS: &str = "
CREATE TABLE IF NOT EXISTS api_keys (
    id                TEXT PRIMARY KEY NOT NULL,
    provider          TEXT NOT NULL,
    label             TEXT NOT NULL DEFAULT '',
    base_url          TEXT,
    secret_ciphertext TEXT NOT NULL,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at        INTEGER
);

CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY NOT NULL,
    title      TEXT NOT NULL DEFAULT 'New chat',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT
);
";

/// Process-local monotonic counter so two rows minted in the same millisecond
/// still get distinct ids (the timestamp prefix keeps them roughly sortable).
static SEQ: AtomicU64 = AtomicU64::new(0);

/// A time-ordered, collision-resistant id (`prefix_<ms hex>_<seq hex>`). We don't
/// pull in a ULID crate — rows also carry a `created_at`, so ordering never
/// depends on the id itself.
fn new_id(prefix: &str) -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{ms:x}_{seq:x}")
}

/// Clamp a derived conversation title to a sane length (char-boundary safe).
fn title_from(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.chars().count() <= 60 {
        trimmed.to_string()
    } else {
        let mut s: String = trimmed.chars().take(57).collect();
        s.push('…');
        s
    }
}

/// Owns the opened SQLite connection. Managed by Tauri state. A `Mutex` makes it
/// `Sync` (rusqlite's `Connection` is `Send` but not `Sync`); the guard is never
/// held across an `.await`, so async commands stay sound.
pub struct MemoryHandle {
    conn: Mutex<Connection>,
}

impl MemoryHandle {
    /// Open (creating if needed) the DB at `path` and apply migrations.
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("opening db: {e}"))?;
        // execute_batch tolerates pragmas that return a row (e.g. journal_mode).
        let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
        conn.execute_batch(MIGRATIONS)
            .map_err(|e| format!("applying migrations: {e}"))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Execute a non-query statement (INSERT/UPDATE/DELETE/DDL), returning
    /// `(rows_affected, last_insert_rowid)`. `rusqlite::execute` runs a SINGLE
    /// statement, which also bounds the blast radius of the raw-SQL bridge.
    pub fn execute(&self, sql: &str, params: &[Value]) -> Result<(usize, i64), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let binds: Vec<SqlValue> = params.iter().map(json_to_sql).collect();
        let affected = conn
            .execute(sql, rusqlite::params_from_iter(binds))
            .map_err(|e| format!("execute: {e}"))?;
        Ok((affected, conn.last_insert_rowid()))
    }

    /// Run a query, returning each row as a POSITIONAL array of column values —
    /// the shape Drizzle's sqlite-proxy maps back onto the selected columns.
    pub fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(sql).map_err(|e| format!("prepare: {e}"))?;
        let col_count = stmt.column_count();
        let binds: Vec<SqlValue> = params.iter().map(json_to_sql).collect();
        let mut rows = stmt
            .query(rusqlite::params_from_iter(binds))
            .map_err(|e| format!("query: {e}"))?;

        let mut out: Vec<Vec<Value>> = Vec::new();
        while let Some(row) = rows.next().map_err(|e| format!("row: {e}"))? {
            let mut r = Vec::with_capacity(col_count);
            for i in 0..col_count {
                let vr = row.get_ref(i).map_err(|e| format!("col {i}: {e}"))?;
                r.push(sql_to_json(vr));
            }
            out.push(r);
        }
        Ok(out)
    }

    // ── Conversation history (semantic API) ─────────────────────────────────
    //
    // These back the history-sidebar commands. They own id minting and the
    // updated_at/title bookkeeping so the frontend never has to; the raw
    // execute/query bridge above remains available for Drizzle's generated SQL.

    /// Create a fresh conversation row and return `(id, title)`. The title is
    /// refined from the first user message on `append_message`.
    pub fn create_conversation(&self, title: &str) -> Result<(String, String), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = new_id("conv");
        let title = if title.trim().is_empty() { "New chat".to_string() } else { title_from(title) };
        conn.execute(
            "INSERT INTO conversations (id, title) VALUES (?1, ?2)",
            params![id, title],
        )
        .map_err(|e| format!("create_conversation: {e}"))?;
        Ok((id, title))
    }

    /// All conversations, most-recently-touched first, as `(id, title)`.
    pub fn list_conversations(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, title FROM conversations \
                 ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC",
            )
            .map_err(|e| format!("prepare list_conversations: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| format!("list_conversations: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("list_conversations row: {e}"))
    }

    /// Persist one turn (`role` ∈ user|assistant|tool|system). Mints the message
    /// id, bumps the conversation's `updated_at`, and — for the first user turn —
    /// promotes a still-default title to a snippet of that message. Returns the id.
    pub fn append_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
    ) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = new_id("msg");
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content) VALUES (?1, ?2, ?3, ?4)",
            params![id, conversation_id, role, content],
        )
        .map_err(|e| format!("append_message: {e}"))?;

        // Touch the conversation so the sidebar re-sorts it to the top.
        let _ = conn.execute(
            "UPDATE conversations SET updated_at = (unixepoch() * 1000) WHERE id = ?1",
            params![conversation_id],
        );

        // First real user line names a still-untitled conversation.
        if role == "user" {
            let _ = conn.execute(
                "UPDATE conversations SET title = ?2 \
                 WHERE id = ?1 AND title IN ('New chat', 'Untitled', '')",
                params![conversation_id, title_from(content)],
            );
        }
        Ok(id)
    }

    /// Overwrite a conversation's title (used by the LLM auto-namer on the first
    /// turn). Bumps `updated_at` so the sidebar re-sorts.
    pub fn set_conversation_title(&self, id: &str, title: &str) -> Result<(), String> {
        let title = title_from(title);
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE conversations SET title = ?2, updated_at = (unixepoch() * 1000) WHERE id = ?1",
            params![id, title],
        )
        .map_err(|e| format!("set_conversation_title: {e}"))?;
        Ok(())
    }

    /// Delete a conversation and all of its messages. Messages have no FK cascade,
    /// so they're removed first, then the conversation row. Idempotent (deleting a
    /// missing id is a no-op).
    pub fn delete_conversation(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM messages WHERE conversation_id = ?1", params![id])
            .map_err(|e| format!("delete_conversation messages: {e}"))?;
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])
            .map_err(|e| format!("delete_conversation: {e}"))?;
        Ok(())
    }

    /// Every message in a conversation, oldest first, as `(id, role, content)`.
    pub fn list_messages(&self, conversation_id: &str) -> Result<Vec<(String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, role, content FROM messages \
                 WHERE conversation_id = ?1 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| format!("prepare list_messages: {e}"))?;
        let rows = stmt
            .query_map(params![conversation_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| format!("list_messages: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("list_messages row: {e}"))
    }
}

/// JSON param → SQLite bind value.
fn json_to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                SqlValue::Null
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        // arrays/objects are bound as JSON text (Drizzle json-mode columns).
        other => SqlValue::Text(other.to_string()),
    }
}

/// SQLite column value → JSON.
fn sql_to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(i.into()),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => {
            Value::Array(b.iter().map(|x| Value::Number((*x as u64).into())).collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> MemoryHandle {
        // In-memory DB exercises the same migrations + semantic methods.
        MemoryHandle::open(Path::new(":memory:")).expect("open :memory:")
    }

    #[test]
    fn conversations_persist_and_sort_recent_first() {
        let db = mem();
        let (a, _) = db.create_conversation("first").unwrap();
        let (b, _) = db.create_conversation("second").unwrap();
        // Touch `a` so it sorts ahead of `b` despite being created earlier.
        db.append_message(&a, "user", "hi").unwrap();
        let convos = db.list_conversations().unwrap();
        assert_eq!(convos.len(), 2);
        assert_eq!(convos[0].0, a, "most-recently-touched sorts first");
        assert_eq!(convos[1].0, b);
    }

    #[test]
    fn messages_round_trip_in_order() {
        let db = mem();
        let (c, _) = db.create_conversation("New chat").unwrap();
        db.append_message(&c, "user", "what is 2+2?").unwrap();
        db.append_message(&c, "assistant", "4").unwrap();
        let msgs = db.list_messages(&c).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!((msgs[0].1.as_str(), msgs[0].2.as_str()), ("user", "what is 2+2?"));
        assert_eq!((msgs[1].1.as_str(), msgs[1].2.as_str()), ("assistant", "4"));
    }

    #[test]
    fn first_user_message_titles_an_untitled_conversation() {
        let db = mem();
        let (c, title) = db.create_conversation("").unwrap();
        assert_eq!(title, "New chat");
        db.append_message(&c, "user", "Summarise the quarterly report").unwrap();
        let convos = db.list_conversations().unwrap();
        assert_eq!(convos[0].1, "Summarise the quarterly report");
    }

    #[test]
    fn ids_are_unique_even_back_to_back() {
        let a = new_id("msg");
        let b = new_id("msg");
        assert_ne!(a, b);
    }
}

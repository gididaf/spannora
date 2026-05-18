import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface Conversation {
  id: string;
  title: string;
  cwd: string;
  sdk_session_id: string | null;
  created_at: number;
  last_used_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content_json: string;
  created_at: number;
}

export interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
}

export interface Session {
  id: string;
  user_id: string;
  created_at: number;
  last_used_at: number;
  user_agent: string | null;
}

function resolveDbPath(): string {
  if (process.env.SPANNORA_DB) return path.resolve(process.env.SPANNORA_DB);
  return path.join(os.homedir(), ".spannora", "spannora.db");
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

let db: Database.Database | null = null;

export function openDb(): Database.Database {
  if (db) return db;
  const dbPath = resolveDbPath();
  ensureDir(dbPath);
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      sdk_session_id TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_last_used
      ON conversations(last_used_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv
      ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user
      ON sessions(user_id, last_used_at DESC);
  `);
}

// --- Conversations ---

export function createConversation(params: { cwd: string; title: string }): Conversation {
  const now = Date.now();
  const conv: Conversation = {
    id: randomUUID(),
    title: params.title,
    cwd: params.cwd,
    sdk_session_id: null,
    created_at: now,
    last_used_at: now,
  };
  openDb()
    .prepare(
      `INSERT INTO conversations (id, title, cwd, sdk_session_id, created_at, last_used_at)
       VALUES (@id, @title, @cwd, @sdk_session_id, @created_at, @last_used_at)`,
    )
    .run(conv);
  return conv;
}

export function listConversations(): Conversation[] {
  return openDb()
    .prepare(
      `SELECT id, title, cwd, sdk_session_id, created_at, last_used_at
       FROM conversations
       ORDER BY last_used_at DESC`,
    )
    .all() as Conversation[];
}

export function getConversation(id: string): Conversation | null {
  const row = openDb()
    .prepare(
      `SELECT id, title, cwd, sdk_session_id, created_at, last_used_at
       FROM conversations WHERE id = ?`,
    )
    .get(id);
  return (row as Conversation | undefined) ?? null;
}

export function updateConversation(
  id: string,
  patch: { title?: string; sdk_session_id?: string | null; last_used_at?: number },
): void {
  const fields: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.title !== undefined) { fields.push("title = @title"); params.title = patch.title; }
  if (patch.sdk_session_id !== undefined) { fields.push("sdk_session_id = @sdk_session_id"); params.sdk_session_id = patch.sdk_session_id; }
  if (patch.last_used_at !== undefined) { fields.push("last_used_at = @last_used_at"); params.last_used_at = patch.last_used_at; }
  if (!fields.length) return;
  openDb()
    .prepare(`UPDATE conversations SET ${fields.join(", ")} WHERE id = @id`)
    .run(params);
}

export function touchConversation(id: string): void {
  openDb()
    .prepare(`UPDATE conversations SET last_used_at = ? WHERE id = ?`)
    .run(Date.now(), id);
}

export function deleteConversation(id: string): void {
  openDb().prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

// --- Messages ---

export function insertMessage(params: {
  conversation_id: string;
  role: string;
  content_json: string;
}): Message {
  const msg: Message = {
    id: randomUUID(),
    conversation_id: params.conversation_id,
    role: params.role,
    content_json: params.content_json,
    created_at: Date.now(),
  };
  openDb()
    .prepare(
      `INSERT INTO messages (id, conversation_id, role, content_json, created_at)
       VALUES (@id, @conversation_id, @role, @content_json, @created_at)`,
    )
    .run(msg);
  return msg;
}

export function getMessages(conversation_id: string): Message[] {
  return openDb()
    .prepare(
      `SELECT id, conversation_id, role, content_json, created_at
       FROM messages WHERE conversation_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(conversation_id) as Message[];
}

// --- Users ---

export function countUsers(): number {
  const row = openDb().prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number };
  return row.n;
}

export function createUser(params: { username: string; password_hash: string }): User {
  const user: User = {
    id: randomUUID(),
    username: params.username,
    password_hash: params.password_hash,
    created_at: Date.now(),
  };
  openDb()
    .prepare(
      `INSERT INTO users (id, username, password_hash, created_at)
       VALUES (@id, @username, @password_hash, @created_at)`,
    )
    .run(user);
  return user;
}

export function getUserByUsername(username: string): User | null {
  const row = openDb()
    .prepare(`SELECT id, username, password_hash, created_at FROM users WHERE username = ?`)
    .get(username);
  return (row as User | undefined) ?? null;
}

export function getUserById(id: string): User | null {
  const row = openDb()
    .prepare(`SELECT id, username, password_hash, created_at FROM users WHERE id = ?`)
    .get(id);
  return (row as User | undefined) ?? null;
}

export function deleteAllUsers(): void {
  openDb().prepare(`DELETE FROM users`).run();
}

// --- Sessions ---

export function createSession(params: { user_id: string; user_agent: string | null }): Session {
  const now = Date.now();
  const session: Session = {
    id: randomUUID(),
    user_id: params.user_id,
    created_at: now,
    last_used_at: now,
    user_agent: params.user_agent,
  };
  openDb()
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, last_used_at, user_agent)
       VALUES (@id, @user_id, @created_at, @last_used_at, @user_agent)`,
    )
    .run(session);
  return session;
}

export function getSession(id: string): Session | null {
  const row = openDb()
    .prepare(
      `SELECT id, user_id, created_at, last_used_at, user_agent
       FROM sessions WHERE id = ?`,
    )
    .get(id);
  return (row as Session | undefined) ?? null;
}

export function touchSession(id: string): void {
  openDb()
    .prepare(`UPDATE sessions SET last_used_at = ? WHERE id = ?`)
    .run(Date.now(), id);
}

export function listSessionsForUser(user_id: string): Session[] {
  return openDb()
    .prepare(
      `SELECT id, user_id, created_at, last_used_at, user_agent
       FROM sessions WHERE user_id = ?
       ORDER BY last_used_at DESC`,
    )
    .all(user_id) as Session[];
}

export function deleteSession(id: string): void {
  openDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function deleteSessionsOlderThan(cutoff: number): number {
  const result = openDb()
    .prepare(`DELETE FROM sessions WHERE last_used_at < ?`)
    .run(cutoff);
  return result.changes;
}

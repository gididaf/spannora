import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  countUsers,
  createUser,
  getUserByUsername,
  getUserById,
  deleteAllUsers,
  createSession,
  getSession,
  touchSession,
  deleteSession,
  deleteSessionsOlderThan,
  type User,
  type Session,
} from "./db.js";
import { log, banner } from "./log.js";

const COOKIE_NAME = "spannora_session";
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let setupToken: string | null = null;

export function initAuth(): { setupTokenIssued: boolean } {
  // Garbage-collect old sessions on startup.
  const cutoff = Date.now() - SESSION_IDLE_MS;
  const removed = deleteSessionsOlderThan(cutoff);
  if (removed > 0) log.info("expired idle sessions", { count: removed });

  if (process.env.SPANNORA_RESET === "1") {
    deleteAllUsers();
    log.warn("SPANNORA_RESET=1 — all users and sessions deleted");
  }

  if (countUsers() === 0) {
    setupToken = randomBytes(24).toString("base64url");
    banner([
      "",
      "┌─────────────────────────────────────────────────────────────────────┐",
      "│ spannora setup required.                                            │",
      "│ Open the app in a browser and use this one-time token to create     │",
      "│ your account:                                                       │",
      "│                                                                     │",
      `│   ${setupToken}${" ".repeat(Math.max(0, 65 - setupToken.length))}│`,
      "│                                                                     │",
      "└─────────────────────────────────────────────────────────────────────┘",
      "",
    ]);
    return { setupTokenIssued: true };
  }
  return { setupTokenIssued: false };
}

export function isSetupNeeded(): boolean {
  return countUsers() === 0;
}

export function consumeSetupToken(token: string): boolean {
  if (!setupToken) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(setupToken);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  setupToken = null;
  return true;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export async function createUserAccount(username: string, password: string): Promise<User> {
  if (!username.trim() || username.length > 64) throw new Error("Invalid username");
  if (!password || password.length < 8) throw new Error("Password must be at least 8 characters");
  if (getUserByUsername(username)) throw new Error("Username taken");
  const password_hash = await hashPassword(password);
  return createUser({ username: username.trim(), password_hash });
}

export async function authenticate(username: string, password: string): Promise<User | null> {
  const user = getUserByUsername(username.trim());
  if (!user) {
    // Constant-time-ish: still run a bcrypt compare against a dummy hash so
    // response time doesn't leak whether the username exists.
    await bcrypt.compare(password, "$2a$12$abcdefghijklmnopqrstuv");
    return null;
  }
  const ok = await verifyPassword(password, user.password_hash);
  return ok ? user : null;
}

// --- Cookie helpers ---

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isHttps(req: http.IncomingMessage): boolean {
  // Behind Caddy we'll see X-Forwarded-Proto: https.
  const xfp = req.headers["x-forwarded-proto"];
  if (typeof xfp === "string" && xfp.toLowerCase() === "https") return true;
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

function serializeSessionCookie(value: string, req: http.IncomingMessage): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_IDLE_MS / 1000)}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearedSessionCookie(req: http.IncomingMessage): string {
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

export function setSessionCookie(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
  res.setHeader("Set-Cookie", serializeSessionCookie(sessionId, req));
}

export function clearSessionCookie(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader("Set-Cookie", clearedSessionCookie(req));
}

export interface AuthedRequest {
  user: User;
  session: Session;
}

export function readSession(req: http.IncomingMessage): AuthedRequest | null {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[COOKIE_NAME];
  if (!sid) return null;
  const session = getSession(sid);
  if (!session) return null;
  if (Date.now() - session.last_used_at > SESSION_IDLE_MS) {
    deleteSession(sid);
    return null;
  }
  const user = getUserById(session.user_id);
  if (!user) {
    deleteSession(sid);
    return null;
  }
  touchSession(sid);
  return { user, session };
}

export function startSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  user: User,
): Session {
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;
  const session = createSession({ user_id: user.id, user_agent: ua });
  setSessionCookie(req, res, session.id);
  return session;
}

export function endSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[COOKIE_NAME];
  if (sid) deleteSession(sid);
  clearSessionCookie(req, res);
}

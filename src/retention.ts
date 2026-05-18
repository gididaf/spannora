// Periodic retention sweep. Deletes conversations untouched longer than
// SPANNORA_RETENTION_DAYS days, plus the matching Claude Code session
// transcript file on disk (~/.claude/projects/<encoded-cwd>/<session-id>.jsonl).
//
// Unset SPANNORA_RETENTION_DAYS → no retention runs.
//
// The sweep runs once on startup (after a short grace period) and every
// hour after that.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteConversation, listOldConversations, type Conversation } from "./db.js";
import { log } from "./log.js";

const HOUR_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;

function retentionDays(): number | null {
  const raw = process.env.SPANNORA_RETENTION_DAYS;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Encode a cwd into the Claude Code projects directory name. Claude replaces
 * every `/` with `-` (including a leading hyphen for absolute paths).
 *
 *   /home/alice/code → -home-alice-code
 */
function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function jsonlPath(conv: Conversation): string | null {
  if (!conv.sdk_session_id) return null;
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    encodeCwd(conv.cwd),
    `${conv.sdk_session_id}.jsonl`,
  );
}

function removeJsonl(p: string): boolean {
  try {
    fs.unlinkSync(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    log.warn("failed to delete session transcript", { path: p, err });
    return false;
  }
}

function sweep(days: number): void {
  const cutoff = Date.now() - days * 24 * HOUR_MS;
  let old: Conversation[];
  try {
    old = listOldConversations(cutoff);
  } catch (err) {
    log.error("retention listOldConversations failed", { err });
    return;
  }
  if (old.length === 0) return;

  let removedConvs = 0;
  let removedFiles = 0;
  for (const conv of old) {
    const jp = jsonlPath(conv);
    if (jp && removeJsonl(jp)) removedFiles++;
    try {
      deleteConversation(conv.id);
      removedConvs++;
    } catch (err) {
      log.warn("retention delete failed", { id: conv.id, err });
    }
  }
  log.info("retention sweep", {
    days,
    cutoff,
    conversations_deleted: removedConvs,
    transcripts_deleted: removedFiles,
  });
}

export function startRetention(): void {
  const days = retentionDays();
  if (days === null) {
    log.info("retention disabled", { reason: "SPANNORA_RETENTION_DAYS unset or invalid" });
    return;
  }
  log.info("retention enabled", { days, interval_ms: HOUR_MS });
  setTimeout(() => sweep(days), STARTUP_DELAY_MS).unref();
  setInterval(() => sweep(days), HOUR_MS).unref();
}

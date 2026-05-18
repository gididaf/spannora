// Structured JSON logger.
//
// One JSON object per line on stdout (stderr for errors). Designed to be
// `journalctl -u spannora -o json`-friendly: every entry has `ts`, `level`,
// `msg`, plus whatever keyed fields the caller adds.
//
//   log.info("user logged in", { user_id });
//   log.error("db write failed", { err });
//
// `err` is unwrapped to { message, stack, name } automatically so Error
// objects survive JSON.stringify.

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  const raw = (process.env.SPANNORA_LOG_LEVEL || "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

const MIN_LEVEL = LEVEL_RANK[envLevel()];

function unwrap(value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, name: value.name, stack: value.stack };
  }
  return value;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < MIN_LEVEL) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) entry[k] = unwrap(v);
  }
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

// Banner helper for human-meaningful startup output (setup token, listen
// address). Skipped entirely when SPANNORA_LOG_FORMAT=json — for development
// you want pretty output, for systemd journalctl you want JSON only.
export function banner(lines: string[]): void {
  if (process.env.SPANNORA_LOG_FORMAT === "json") {
    log.info("banner", { lines });
    return;
  }
  for (const line of lines) process.stdout.write(line + "\n");
}

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export interface LogEntry extends LogFields {
  ts: string;
  level: LogLevel;
  event: string;
}
export interface LogQuery {
  level?: LogLevel;
  event?: string;
  worker?: string;
  manager?: string;
  request_id?: string;
  since?: string;
  limit?: number;
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const KEPT_ROTATIONS = 3;
const SECRET_KEY = /key|token|secret|password|authorization/i;
const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]"],
];

/**
 * Directory holding server.log and per-worker output files.
 *
 * Precedence: `OCM_STATE_DIR` > `XDG_STATE_HOME` > `~/.local/state`, always
 * under an `opencode-worker-server` folder. Resolved on every call so tests
 * can point it at a temp dir.
 */
export function stateDir(): string {
  const base =
    process.env.OCM_STATE_DIR ?? process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return process.env.OCM_STATE_DIR ? base : join(base, "opencode-worker-server");
}

export function serverLogPath(): string {
  return join(stateDir(), "logs", "server.log");
}

export function workerLogPath(workerId: string): string {
  return join(stateDir(), "logs", "workers", `${workerId.replace(/[^\w.-]/g, "_")}.log`);
}

/** Mask credentials in free text or nested data before anything touches disk. */
export function redact<T>(value: T): T {
  if (typeof value === "string") {
    const masked = SECRET_PATTERNS.reduce(
      (text: string, [pattern, to]) => text.replace(pattern, to),
      value as string,
    );
    return masked as T;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item)) as T;
  if (value instanceof Error) return redact(errorFields(value)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) && typeof item === "string" ? "[redacted]" : redact(item),
      ]),
    ) as T;
  }
  return value;
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function minLevel(): number {
  return LEVELS[process.env.OCM_LOG_LEVEL as LogLevel] ?? LEVELS.info;
}

function rotateIfNeeded(path: string): void {
  if (!existsSync(path) || statSync(path).size < MAX_LOG_BYTES) return;
  const oldest = `${path}.${KEPT_ROTATIONS}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let n = KEPT_ROTATIONS - 1; n >= 1; n--) {
    if (existsSync(`${path}.${n}`)) renameSync(`${path}.${n}`, `${path}.${n + 1}`);
  }
  renameSync(path, `${path}.1`);
}

function append(path: string, line: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  rotateIfNeeded(path);
  appendFileSync(path, `${line}\n`);
}

/**
 * Write one JSON line to server.log. Never throws: a logging failure must not
 * take a launch or a kill down with it, so it falls back to stderr.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  if (LEVELS[level] < minLevel()) return;
  try {
    const entry = redact({ ts: new Date().toISOString(), level, event, ...fields });
    append(serverLogPath(), JSON.stringify(entry));
  } catch (error) {
    console.error(`ocm log failure for ${event}:`, error);
  }
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** Logger that stamps `base` (request_id, manager, worker...) on every line. */
export function createLogger(base: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (event: string, fields: LogFields = {}) =>
      log(level, event, { ...base, ...fields });
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

/** Keep a worker's raw stdout/stderr so a dead worker can be diagnosed after the fact. */
export function appendWorkerOutput(
  workerId: string,
  stream: "stdout" | "stderr",
  chunk: string,
): void {
  try {
    const lines = redact(chunk)
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => `${new Date().toISOString()} ${stream} ${line}`);
    if (lines.length > 0) append(workerLogPath(workerId), lines.join("\n"));
  } catch (error) {
    console.error(`ocm worker log failure for ${workerId}:`, error);
  }
}

/** Filtered read of server.log (newest last) backing the `logs` action. */
export function readLogs(query: LogQuery = {}): LogEntry[] {
  const path = serverLogPath();
  if (!existsSync(path)) return [];
  const min = LEVELS[query.level ?? "debug"];
  const entries: LogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let entry: LogEntry;
    try {
      entry = JSON.parse(line) as LogEntry;
    } catch {
      continue;
    }
    if (LEVELS[entry.level] < min) continue;
    if (query.event && !entry.event.includes(query.event)) continue;
    if (query.worker && entry.worker !== query.worker) continue;
    if (query.manager && entry.manager !== query.manager) continue;
    if (query.request_id && entry.request_id !== query.request_id) continue;
    if (query.since && entry.ts < query.since) continue;
    entries.push(entry);
  }
  return entries.slice(-(query.limit ?? 100));
}

/** Record fatal errors that would otherwise vanish with the process. */
export function installCrashLogging(): void {
  process.on("uncaughtException", (error) => {
    log("error", "process.uncaught_exception", errorFields(error));
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log("error", "process.unhandled_rejection", errorFields(reason));
  });
}

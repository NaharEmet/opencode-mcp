import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { workersDir } from "./evidence.js";
import { markModelWorking } from "./gate.js";
import { type LimitKind, parseWorkerEvent } from "./limits.js";
import { createLogger, errorFields, redact, stateDir } from "./log.js";
import { loadState, updateState, type WorkerRecord } from "./state.js";

const log = createLogger({ module: "ocm.monitor" });

const LOCK_TIMEOUT_MS = 2000;
const STALE_LOCK_MS = 10000;
const LOCK_RETRY_MS = 25;
const DEFAULT_STALL_MS = 15 * 60_000;

export type MonitorEventKind =
  | "started"
  | "first_response"
  | "limit"
  | "done"
  | "failed"
  | "died"
  | "stalled";

export interface MonitorEvent {
  seq: number;
  at: string;
  worker: string;
  owner: string;
  kind: MonitorEventKind;
  detail?: string;
}

export interface WorkerSummary {
  id: string;
  pid: number;
  owner: string;
  ticket?: string;
  model: string;
  state: string;
  ageSec: number;
  idleSec?: number;
  session?: string;
}

interface IngestProgress {
  bytesRead: number;
  sawText: boolean;
  sawError: boolean;
}

/** Per-worker ingest progress. A cold start (entry absent) re-reads from byte 0. */
const progressMap = new Map<string, IngestProgress>();

function eventsPath(): string {
  return join(stateDir(), "events.jsonl");
}

/** Idle threshold: OCM_STALL_MS when positive, else 15 minutes. */
function stallMs(): number {
  const parsed = Number(process.env.OCM_STALL_MS);
  return parsed > 0 ? parsed : DEFAULT_STALL_MS;
}

/** Complete JSONL lines of `raw`: nothing when it holds only a partial last line. */
function outLines(raw: string): string[] {
  if (raw.length > 0 && !raw.endsWith("\n")) {
    // drop the trailing partial line until it completes
    raw = raw.slice(0, raw.lastIndexOf("\n") + 1);
  }
  return raw.split("\n").filter((line) => line !== "");
}

/** Run fn under an exclusive lock over events.jsonl, or throw after ~2s of contention. */
function withEventsLock<T>(fn: () => T): T {
  mkdirSync(stateDir(), { recursive: true });
  const lock = `${eventsPath()}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`events lock busy after ${LOCK_TIMEOUT_MS}ms: ${lock}`);
      }
      let stale = true; // a lock we cannot stat is gone or garbage: safe to clear
      try {
        stale = Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS;
      } catch (statError) {
        log.debug("monitor.lock.stat_failed", errorFields(statError));
      }
      if (stale) {
        unlinkSync(lock);
        log.warn("monitor.lock.stale", { lock });
        continue;
      }
      log.warn("monitor.lock.wait", { lock });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

/** Append one monitor event; seq is the 1-based line number under the events lock. */
export function appendEvent(
  e: Omit<MonitorEvent, "seq" | "at">,
  now: Date = new Date(),
): MonitorEvent {
  const path = eventsPath();
  const event = withEventsLock(() => {
    const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
    const seq = raw.split("\n").filter((line) => line !== "").length + 1;
    const full: MonitorEvent = { ...e, seq, at: now.toISOString() };
    appendFileSync(path, `${JSON.stringify(full)}\n`);
    return full;
  });
  log.info("monitor.event", {
    seq: event.seq,
    worker: event.worker,
    owner: event.owner,
    kind: event.kind,
    detail: event.detail,
  });
  return event;
}

/** Read events.jsonl filtered by owner and seq > sinceSeq; corrupt lines are skipped. */
export function readEvents(opts: { owner?: string; sinceSeq?: number } = {}): MonitorEvent[] {
  const path = eventsPath();
  if (!existsSync(path)) return [];
  const events: MonitorEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue;
    let event: MonitorEvent;
    try {
      event = JSON.parse(line) as MonitorEvent;
    } catch {
      continue;
    }
    if (opts.owner !== undefined && event.owner !== opts.owner) continue;
    if (opts.sinceSeq !== undefined && event.seq <= opts.sinceSeq) continue;
    events.push(event);
  }
  return events;
}

function hasEvent(kind: MonitorEventKind, id: string): boolean {
  return readEvents().some((event) => event.kind === kind && event.worker === id);
}

/** True when a limit event for this worker and kind was already appended. */
function hasLimitEvent(id: string, kind: LimitKind): boolean {
  return readEvents().some(
    (event) =>
      event.kind === "limit" && event.worker === id && event.detail?.startsWith(`${kind} until`),
  );
}

/** Mutate one record inside state; a record another writer deleted is ignored. */
function withRecord(id: string, apply: (record: WorkerRecord) => void): void {
  updateState((state) => {
    const record = state.workers[id];
    if (record) apply(record);
  });
}

/**
 * Ingest a worker's `<id>.out.jsonl`: parse only bytes that arrived since the
 * last call (a trailing partial line waits until it completes), capture the
 * first sessionID and newest timestamps into the record, and turn the first
 * text event into markModelWorking + a first_response event and each recognized
 * limit error into a per-kind limit event. A cold start re-reads from byte 0;
 * the append-time checks keep that idempotent against events already on disk.
 */
export function ingestWorker(id: string, now: Date = new Date()): void {
  const record = loadState().workers[id];
  const outPath = join(workersDir(), `${id}.out.jsonl`);
  if (!record || !existsSync(outPath)) return;
  const progress = progressMap.get(id) ?? { bytesRead: 0, sawText: false, sawError: false };
  const bytes = readFileSync(outPath);
  const end = bytes.lastIndexOf(10) + 1; // last complete-line boundary, 0 when none
  const fresh =
    end > progress.bytesRead ? bytes.slice(progress.bytesRead, end).toString("utf8") : "";
  progress.bytesRead = Math.max(progress.bytesRead, end);
  let firstSession: string | undefined;
  let newest: number | undefined;
  let parsed = 0;
  for (const line of fresh.split("\n")) {
    if (line === "") continue;
    let event: {
      type?: unknown;
      sessionID?: unknown;
      timestamp?: unknown;
      part?: { text?: unknown };
    };
    try {
      event = JSON.parse(line);
    } catch {
      log.warn("monitor.line_corrupt", { worker: id, chars: line.length });
      continue;
    }
    parsed++;
    if (typeof event.sessionID === "string" && firstSession === undefined) {
      firstSession = event.sessionID;
    }
    if (typeof event.timestamp === "number" && (newest === undefined || event.timestamp > newest)) {
      newest = event.timestamp;
    }
    if (event.type === "text") {
      if (!progress.sawText) {
        markModelWorking(record.model, now);
        if (!hasEvent("first_response", id)) {
          appendEvent({ worker: id, owner: record.owner, kind: "first_response" }, now);
        }
      }
      progress.sawText = true;
    } else if (event.type === "error") {
      progress.sawError = true;
      const hit = parseWorkerEvent(line, record.model);
      if (hit && !hasLimitEvent(id, hit.kind)) {
        appendEvent(
          {
            worker: id,
            owner: record.owner,
            kind: "limit",
            detail: `${hit.kind} until ${hit.resetAt ?? "cleared by a successful run"}`,
          },
          now,
        );
      }
    }
  }
  if (firstSession !== undefined || newest !== undefined) {
    withRecord(id, (worker) => {
      if (firstSession !== undefined && worker.session === undefined) worker.session = firstSession;
      if (newest !== undefined) {
        worker.lastActivityAt = new Date(newest).toISOString();
        // output grew again: a stalled worker is back to work
        if (worker.state === "stalled") worker.state = "running";
      }
    });
  }
  progressMap.set(id, progress);
  log.debug("monitor.ingest", { worker: id, bytes: fresh.length, events: parsed });
}

/**
 * Liveness by signal 0. ESRCH means gone; any other failure (another owner's
 * process) is treated as alive and logged, so records are not dropped on EPERM.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    log.warn("monitor.liveness_failed", { pid, ...errorFields(error) });
    return true;
  }
}

/** Current size of `<id>.out.jsonl`; 0 when it does not exist. */
function outSize(id: string): number {
  try {
    return statSync(join(workersDir(), `${id}.out.jsonl`)).size;
  } catch {
    return 0;
  }
}

/** Parsed last complete event of a worker output file; undefined without one. */
function lastOutEvent(id: string): { type?: unknown; part?: { reason?: unknown } } | undefined {
  const outPath = join(workersDir(), `${id}.out.jsonl`);
  if (!existsSync(outPath)) return undefined;
  const last = outLines(readFileSync(outPath, "utf8")).at(-1);
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last) as { type?: unknown; part?: { reason?: unknown } };
  } catch {
    return undefined;
  }
}

/** Redacted last 300 chars of `<id>.err.log`; "" when it is empty or missing. */
function errTail(id: string): string {
  const path = join(workersDir(), `${id}.err.log`);
  if (!existsSync(path)) return "";
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    log.warn("monitor.err_unreadable", { worker: id, ...errorFields(error) });
    return "";
  }
  if (raw === "") return "";
  return redact(raw.slice(-300));
}

/** Persist a dead worker's terminal state; the pid is no longer around. */
function finalizeDead(id: string, owner: string, now: Date): void {
  const last = lastOutEvent(id);
  const clean = last?.type === "step_finish" && last?.part?.reason === "stop";
  withRecord(id, (record) => {
    if (record.state !== "running") return; // another writer already finished it
    record.state = clean ? "done" : "failed";
    if (!clean) record.endedAt = now.toISOString();
    // exitCode stays unset: the spawning parent owns the exit status
  });
  const kind: MonitorEventKind = clean ? "done" : "died";
  const expected = clean ? "done" : "failed";
  if (!hasEvent(kind, id) && loadState().workers[id]?.state === expected) {
    let detail: string | undefined;
    if (!clean) {
      const lastType = typeof last?.type === "string" ? last.type : "unknown";
      detail = `last event ${lastType}`;
      const tail = errTail(id);
      if (tail !== "") detail += `; ${tail}`;
    }
    appendEvent({ worker: id, owner, kind, detail }, now);
  }
}

function markStalled(id: string, owner: string, now: Date): void {
  withRecord(id, (record) => {
    if (record.state !== "running") return; // another writer moved it already
    record.state = "stalled";
  });
  if (!hasEvent("stalled", id) && loadState().workers[id]?.state === "stalled") {
    appendEvent({ worker: id, owner, kind: "stalled" }, now);
  }
}

/**
 * Reconcile every tracked worker with the process table: ingest fresh output,
 * append `started` once per running worker, then mark dead pids done (clean
 * step_finish:stop) or failed (`died` with the last event and redacted stderr
 * tail), idle ones stalled when they exceed OCM_STALL_MS, and stalled ones
 * back to running when their output grows again.
 */
export function sweep(now: Date = new Date()): void {
  const preSize = new Map<string, number>();
  for (const worker of Object.values(loadState().workers)) {
    if (worker.state !== "running" && worker.state !== "stalled") continue;
    if (worker.state === "stalled") preSize.set(worker.id, outSize(worker.id));
    // announce the start before ingest can append first_response or limit events
    if (worker.state === "running" && !hasEvent("started", worker.id)) {
      appendEvent({ worker: worker.id, owner: worker.owner, kind: "started" }, now);
    }
    ingestWorker(worker.id, now);
  }
  const state = loadState();
  let running = 0;
  let finished = 0;
  let idled = 0;
  let recovered = 0;
  for (const worker of Object.values(state.workers)) {
    if (worker.state === "running") {
      running++;
      if (!alive(worker.pid)) {
        finished++;
        finalizeDead(worker.id, worker.owner, now);
        continue;
      }
      const activeAt = worker.lastActivityAt ?? worker.startedAt;
      if (now.getTime() - Date.parse(activeAt) > stallMs()) {
        idled++;
        markStalled(worker.id, worker.owner, now);
      }
    } else if (worker.state === "stalled" && outSize(worker.id) > (preSize.get(worker.id) ?? 0)) {
      recovered++;
      withRecord(worker.id, (record) => {
        if (record.state !== "stalled") return; // another writer moved it already
        record.state = "running";
      });
    }
  }
  log.debug("monitor.sweep", {
    workers: Object.keys(state.workers).length,
    running,
    finished,
    idled,
    recovered,
  });
}

/** Newest-first worker table with age/idle in seconds, optionally for one owner. */
export function psRows(owner?: string): WorkerSummary[] {
  const now = Date.now();
  return Object.values(loadState().workers)
    .filter((worker) => owner === undefined || worker.owner === owner)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .map((worker) => ({
      id: worker.id,
      pid: worker.pid,
      owner: worker.owner,
      ...(worker.ticket === undefined ? {} : { ticket: worker.ticket }),
      model: worker.model,
      state: worker.state,
      ageSec: Math.max(0, Math.floor((now - Date.parse(worker.startedAt)) / 1000)),
      ...(worker.lastActivityAt === undefined
        ? {}
        : { idleSec: Math.max(0, Math.floor((now - Date.parse(worker.lastActivityAt)) / 1000)) }),
      ...(worker.session === undefined ? {} : { session: worker.session }),
    }));
}

/** Result snapshot for one worker: last `maxChars` of text events plus git status. */
export function workerResult(
  id: string,
  maxChars: number = 4000,
): {
  id: string;
  state: string;
  exitCode?: number;
  text: string;
  diffStat: string;
  truncated: boolean;
} {
  const record = loadState().workers[id];
  if (record === undefined) throw new Error(`unknown worker: ${id}`);
  let text = "";
  const outPath = join(workersDir(), `${id}.out.jsonl`);
  if (existsSync(outPath)) {
    for (const line of outLines(readFileSync(outPath, "utf8"))) {
      try {
        const event = JSON.parse(line) as { type?: unknown; part?: { text?: unknown } };
        if (event.type === "text" && typeof event.part?.text === "string") {
          text += (text === "" ? "" : "\n") + event.part.text;
        }
      } catch {
        // a non-JSON output line contributes no text
      }
    }
  }
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(text.length - maxChars);
  let diffStat = "";
  try {
    diffStat =
      execFileSync("git", ["diff", "--stat"], { cwd: record.cwd, timeout: 5000 }).toString() +
      execFileSync("git", ["status", "--short"], { cwd: record.cwd, timeout: 5000 }).toString();
  } catch (error) {
    diffStat = "";
    log.warn("monitor.git_failed", { worker: id, cwd: record.cwd, ...errorFields(error) });
  }
  return { id, state: record.state, exitCode: record.exitCode, text, diffStat, truncated };
}

/**
 * Poll the event log, calling sweep() each round, until at least one matching
 * event is new or `waitMs` (default 30000, capped at 60000) passes; then [].
 */
export async function waitForEvents(
  opts: { owner?: string; sinceSeq?: number; waitMs?: number; pollMs?: number } = {},
): Promise<MonitorEvent[]> {
  const waitMs = Math.min(opts.waitMs ?? 30000, 60000);
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + waitMs;
  for (;;) {
    sweep();
    const found = readEvents({ owner: opts.owner, sinceSeq: opts.sinceSeq });
    if (found.length > 0) return found;
    if (Date.now() >= deadline) return [];
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  }
}

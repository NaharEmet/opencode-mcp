import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { createLogger, errorFields } from "./log.js";
import { loadState, updateState, upsertWorker, type WorkerRecord } from "./state.js";

const log = createLogger({ module: "reaper" });

const KILL_WAIT_MS = 5000;
const KILL_POLL_MS = 100;
const REAPABLE: WorkerRecord["state"][] = ["running", "stalled", "orphan"];

/** One foreign process discovered by ps, feeding adoptOrphans. */
export interface ProcessInfo {
  pid: number;
  ageSec: number;
  cwd?: string;
  model?: string;
  cmdline: string;
}

/** Pluggable effects so tests can fake processes, kills and owner events. */
export interface ReaperDeps {
  emit(e: {
    worker: string;
    owner: string;
    kind: "reap_ask" | "reaped" | "orphan";
    detail: string;
  }): void;
  isAlive(pid: number): boolean;
  kill(pid: number): Promise<void>;
  hasUncommitted(cwd: string): boolean;
  listProcesses(): ProcessInfo[];
}

/** env override in ms with a default; resolved per call so tests can vary it. */
function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Age a worker must reach before the owner is asked about it. */
const reapAfterMs = (): number => envMs("OCM_REAP_AFTER_MS", 3_600_000);
/** Silence stretch after the ask that must pass before a kill. */
const graceMs = (): number => envMs("OCM_REAP_GRACE_MS", 900_000);
/** Idleness that counts a worker as unused. */
const idleLimitMs = (): number => envMs("OCM_REAP_IDLE_MS", 900_000);

/** `1h12m` style duration for ask and kill messages. */
function fmtDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return hours === 0 ? `${mins}m` : `${hours}h${mins}m`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Signal the process group first (detached workers lead one), falling back to the pid. */
function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch (error) {
      log.debug("reaper.signal_failed", { pid, sig, ...errorFields(error) });
    }
  }
}

/** Pids of every living ancestor of this process, walking ppid links through ps. */
function ownAncestors(): Set<number> {
  const seen = new Set<number>();
  let cur = process.ppid;
  while (cur > 1 && !seen.has(cur)) {
    seen.add(cur);
    try {
      const out = execFileSync("ps", ["-o", "ppid=", "-p", String(cur)], {
        timeout: KILL_WAIT_MS,
      }).toString();
      cur = Number(out.trim());
    } catch {
      return seen; // unreadable ancestor chain: keep what we have
    }
  }
  return seen;
}

function askDetail(worker: WorkerRecord, ageMs: number): string {
  return `worker ${worker.id} (${worker.model}, ticket ${worker.ticket ?? "none"}) is ${fmtDuration(
    ageMs,
  )} old; still using it? keep ${worker.id} or release ${worker.id}`;
}

/** Mark a record killed; a record that vanished mid-run throws (caught by reapStep). */
function markKilled(id: string, now: Date, killReason: string): void {
  const iso = now.toISOString();
  updateState((state) => {
    const worker = state.workers[id];
    worker.state = "killed";
    worker.endedAt = iso;
    worker.killReason = killReason;
  });
}

/**
 * Kill tail shared by reapStep and releaseWorker: read the worktree BEFORE the
 * kill; the worktree itself is never deleted, only reported.
 */
async function killWorker(
  deps: ReaperDeps,
  worker: WorkerRecord,
  now: Date,
  killReason: string,
): Promise<void> {
  const ageMs = now.getTime() - Date.parse(worker.startedAt);
  const idleMs = now.getTime() - Date.parse(worker.lastActivityAt ?? worker.startedAt);
  const uncommitted = deps.hasUncommitted(worker.cwd);
  await deps.kill(worker.pid);
  markKilled(worker.id, now, killReason);
  deps.emit({
    worker: worker.id,
    owner: worker.owner,
    kind: "reaped",
    detail: `worker ${worker.id} killed in ${worker.cwd}; uncommitted changes: ${
      uncommitted ? "yes" : "no"
    } (${killReason})`,
  });
  log.info("reaper.kill", {
    worker: worker.id,
    owner: worker.owner,
    pid: worker.pid,
    age: fmtDuration(ageMs),
    idle: fmtDuration(idleMs),
    uncommitted,
    reason: killReason,
  });
}

/** Apply the ask/grace/kill ladder to one candidate record. */
async function stepWorker(
  deps: ReaperDeps,
  worker: WorkerRecord,
  now: Date,
  nowMs: number,
): Promise<void> {
  if (worker.keepUntil !== undefined && Date.parse(worker.keepUntil) > nowMs) return;
  const ageMs = nowMs - Date.parse(worker.startedAt);
  if (ageMs < reapAfterMs()) return;
  if (!deps.isAlive(worker.pid)) {
    markKilled(worker.id, now, "already exited");
    deps.emit({
      worker: worker.id,
      owner: worker.owner,
      kind: "reaped",
      detail: `worker ${worker.id} already exited`,
    });
    log.info("reaper.already_exited", { worker: worker.id, pid: worker.pid });
    return;
  }
  const askedMs = worker.askedAt === undefined ? null : Date.parse(worker.askedAt);
  if (askedMs !== null && nowMs - askedMs < graceMs()) return;
  const idleMs = nowMs - Date.parse(worker.lastActivityAt ?? worker.startedAt);
  const idle = idleMs >= idleLimitMs();
  if (askedMs === null || !(worker.state === "orphan" || idle)) {
    // first pass, or an active worker past its grace: (re-)ask and restart the window
    const iso = now.toISOString();
    updateState((state) => {
      state.workers[worker.id].askedAt = iso;
    });
    deps.emit({
      worker: worker.id,
      owner: worker.owner,
      kind: "reap_ask",
      detail: askDetail(worker, ageMs),
    });
    log.info("reaper.ask", {
      worker: worker.id,
      owner: worker.owner,
      pid: worker.pid,
      age: fmtDuration(ageMs),
      idle: fmtDuration(idleMs),
    });
    return;
  }
  await killWorker(
    deps,
    worker,
    now,
    `reaped after ${fmtDuration(ageMs)} idle ${fmtDuration(idleMs)}`,
  );
}

/** Real process effects: signal semantics, git checks, and ps discovery. */
export function defaultDeps(emit: ReaperDeps["emit"]): ReaperDeps {
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const kill = async (pid: number): Promise<void> => {
    signal(pid, "SIGTERM");
    const deadline = Date.now() + KILL_WAIT_MS;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return;
      await sleep(KILL_POLL_MS);
    }
    signal(pid, "SIGKILL");
  };
  const hasUncommitted = (cwd: string): boolean => {
    try {
      const out = execFileSync("git", ["status", "--porcelain"], { cwd, timeout: KILL_WAIT_MS });
      return out.toString().trim().length > 0;
    } catch (error) {
      log.warn("reaper.uncommitted_check_failed", { cwd, ...errorFields(error) });
      return false;
    }
  };
  const listProcesses = (): ProcessInfo[] => {
    let out: string;
    try {
      out = execFileSync("ps", ["-eo", "pid=,etimes=,args="], { timeout: KILL_WAIT_MS }).toString();
    } catch (error) {
      log.error("reaper.ps_failed", errorFields(error));
      return [];
    }
    return out
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [pidStr, ageStr, ...args] = line.trim().split(/\s+/);
        const pid = Number(pidStr);
        let cwd: string | undefined;
        try {
          cwd = readlinkSync(`/proc/${pid}/cwd`);
        } catch {
          // exited pids and kernel threads have no cwd link
        }
        const at = args.indexOf("-m");
        return {
          pid,
          ageSec: Number(ageStr),
          cwd,
          model: at >= 0 ? args[at + 1] : undefined,
          cmdline: args.join(" "),
        };
      });
  };
  return { emit, isAlive, kill, hasUncommitted, listProcesses };
}

/**
 * Track stray `opencode run` processes this server does not know about, so the
 * next reapStep can ask about them too. Serve, npm wrappers and shells never qualify.
 */
export function adoptOrphans(deps: ReaperDeps, now: Date = new Date()): void {
  const tracked = new Set(Object.values(loadState().workers).map((w) => w.pid));
  let ancestors: Set<number> | null = null;
  for (const proc of deps.listProcesses()) {
    if (!proc.cmdline.startsWith("opencode run")) continue;
    if (proc.pid === process.pid) continue;
    if (tracked.has(proc.pid)) continue;
    ancestors ??= ownAncestors();
    if (ancestors.has(proc.pid)) continue;
    const id = `orphan-${proc.pid}`;
    const model = proc.model ?? "unknown";
    const cwd = proc.cwd ?? "unknown";
    upsertWorker({
      id,
      pid: proc.pid,
      owner: "orphan",
      model,
      cwd,
      startedAt: new Date(now.getTime() - proc.ageSec * 1000).toISOString(),
      state: "orphan",
    });
    tracked.add(proc.pid);
    deps.emit({
      worker: id,
      owner: "orphan",
      kind: "orphan",
      detail: `worker ${id} adopted; model ${model}; cwd ${cwd}; ${fmtDuration(proc.ageSec * 1000)} old`,
    });
    log.info("reaper.adopt", { worker: id, pid: proc.pid, model, cwd, ageSec: proc.ageSec });
  }
}

/**
 * One pass over reapable workers: ask once, wait out the grace, then kill
 * orphans and idle workers; kept and active workers are left (re-)asked.
 */
export async function reapStep(deps: ReaperDeps, now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime();
  const candidates = Object.values(loadState().workers).filter((w) => REAPABLE.includes(w.state));
  for (const worker of candidates) {
    try {
      await stepWorker(deps, worker, now, nowMs);
    } catch (error) {
      log.error("reaper.step_failed", { worker: worker.id, ...errorFields(error) });
    }
  }
}

/** Owner says keep this worker: protect it and restart the ask window. */
export function keepWorker(id: string, forMs = 3_600_000, now: Date = new Date()): void {
  const keepUntil = new Date(now.getTime() + forMs).toISOString();
  updateState((state) => {
    const worker = state.workers[id];
    if (worker === undefined) throw new Error(`unknown worker: ${id}`);
    worker.keepUntil = keepUntil;
    worker.askedAt = undefined;
  });
  log.info("reaper.keep", { worker: id, forMs, keepUntil });
}

/** Owner says release this worker now: same kill path as reapStep. */
export async function releaseWorker(
  id: string,
  deps: ReaperDeps,
  now: Date = new Date(),
): Promise<void> {
  const worker = loadState().workers[id];
  if (worker === undefined) throw new Error(`unknown worker: ${id}`);
  await killWorker(deps, worker, now, "released by owner");
  log.info("reaper.release", { worker: id, owner: worker.owner, pid: worker.pid });
}

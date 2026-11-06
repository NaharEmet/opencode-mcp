import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type LimitHit,
  parseLimitLine,
  parseSessionLine,
  parseWorkerEvent,
  readLogTail,
} from "./limits.js";
import { createLogger, errorFields, stateDir } from "./log.js";
import { loadState } from "./state.js";

const logger = createLogger({ module: "ocm.evidence" });

const DAY_MS = 86_400_000;
const DEFAULT_LOG = join(homedir(), ".local", "share", "opencode", "log", "opencode.log");

/** Directory holding `<id>.out.jsonl` worker output files. */
export function workersDir(): string {
  return join(stateDir(), "logs", "workers");
}

function splitModel(model: string): [provider: string, id: string] {
  const at = model.indexOf("/");
  return at > 0 ? [model.slice(0, at), model.slice(at + 1)] : ["", model];
}

/**
 * Merge limit evidence from three sources into one oldest-first hit list:
 * old-format stream-error lines and session-keyed drain-failure lines in the
 * opencode.log tail, plus error events from the `*.out.jsonl` output of every
 * started worker. Session-keyed lines are attributed through the workers'
 * sessions (WorkerRecord.session and the first sessionID seen in each output
 * file); unattributable lines are dropped. Never throws.
 */
export function collectHits(
  opts: { logPath?: string; sinceMs?: number; now?: Date } = {},
): LimitHit[] {
  const logPath = opts.logPath ?? DEFAULT_LOG;
  const cutoff = (opts.now ?? new Date()).getTime() - (opts.sinceMs ?? 7 * DAY_MS);
  const hits: LimitHit[] = [];
  const sessions = new Map<string, string>();
  const workers = Object.values(loadState().workers).filter(
    (worker) => Date.parse(worker.startedAt) >= cutoff,
  );
  let workerHits = 0;
  let sessionHits = 0;
  let logHits = 0;

  // WorkerRecord.session is authoritative for its worker's output file.
  for (const worker of workers) {
    if (worker.session) sessions.set(worker.session, worker.model);
  }
  for (const worker of workers) {
    const path = join(workersDir(), `${worker.id}.out.jsonl`);
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      logger.warn("evidence.worker_unreadable", {
        path,
        worker: worker.id,
        ...errorFields(error),
      });
      continue;
    }
    let firstSession: string | undefined;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const session = JSON.parse(line)?.sessionID;
        if (!firstSession && typeof session === "string") firstSession = session;
      } catch {
        // non-JSON worker output line
      }
      const hit = parseWorkerEvent(line, worker.model);
      if (!hit) continue;
      workerHits++;
      hits.push(hit);
    }
    if (firstSession && !sessions.has(firstSession)) sessions.set(firstSession, worker.model);
  }

  try {
    const lines = existsSync(logPath) ? readLogTail(logPath).lines : [];
    let unattributed = 0;
    for (const line of lines) {
      if (!line) continue;
      const old = parseLimitLine(line);
      if (old && Date.parse(old.ts) > cutoff) {
        logHits++;
        hits.push(old);
      }
      const sessionHit = parseSessionLine(line);
      if (!sessionHit) continue;
      const model = sessions.get(sessionHit.session);
      if (!model) {
        unattributed++;
        logger.debug("evidence.session_unattributed", { session: sessionHit.session });
        continue;
      }
      const [provider, id] = splitModel(model);
      sessionHits++;
      hits.push({
        ts: sessionHit.ts,
        provider,
        model: id,
        kind: sessionHit.kind,
        resetAt: sessionHit.resetAt,
        raw: sessionHit.raw,
      });
    }
    if (unattributed > 0 && workerHits + logHits + sessionHits > 0) {
      logger.warn("evidence.unattributed_sessions", { unattributed, attributed: sessionHits });
    }
  } catch (error) {
    logger.warn("evidence.log_unreadable", { path: logPath, ...errorFields(error) });
  }

  logger.debug("evidence.collected", { log: logHits, worker: workerHits, session: sessionHits });
  const seen = new Set<string>();
  const unique = hits.filter((hit) => {
    const key = `${hit.provider}/${hit.model}/${hit.kind}/${hit.ts}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

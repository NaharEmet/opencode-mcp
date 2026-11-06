import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { collectHits } from "./evidence.js";
import { checkLaunch } from "./gate.js";
import { launchWorker, workerOutPath } from "./launch.js";
import {
  applyVerdict,
  type DispatchRecord,
  exportPolicy,
  importPolicy,
  loadLedger,
  pick,
  recordDispatch,
  usageFromOutput,
} from "./ledger.js";
import { currentBlocks } from "./limits.js";
import {
  createLogger,
  errorFields,
  type LogLevel,
  readLogs,
  serverLogPath,
  stateDir,
} from "./log.js";
import { checkLaunchAllowed, type MemoryInfo, readMemory } from "./memory.js";
import { appendEvent, psRows, readEvents, sweep, waitForEvents, workerResult } from "./monitor.js";
import {
  adoptOrphans,
  defaultDeps,
  keepWorker,
  type ReaperDeps,
  reapStep,
  releaseWorker,
} from "./reaper.js";
import { loadState, updateState, type WorkerRecord } from "./state.js";

/**
 * Single entry point behind the `opencode_worker` MCP tool: every worker
 * operation is one action call validated here and served from the ocm
 * modules. Actions never throw; `tick` is the background heartbeat T8b runs.
 */

export const ACTIONS = [
  "run",
  "ps",
  "events",
  "result",
  "restart",
  "budget",
  "pick",
  "verdict",
  "logs",
  "keep",
  "release",
  "ledger",
  "health",
] as const;

export const actionShape: z.ZodRawShape = {
  action: z.enum(ACTIONS).describe("Worker operation to perform"),
  manager: z.string().describe("Calling steward agent id; becomes the worker owner"),
  worker: z.string().optional().describe("Worker id"),
  model: z.string().optional().describe("provider/model; picked from the ledger when omitted"),
  cwd: z.string().optional().describe("Absolute working directory for run"),
  prompt: z.string().optional().describe("Task prompt for run"),
  ticket: z.string().optional().describe("Ticket label recorded on the worker"),
  difficulty: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .optional()
    .describe("Ticket difficulty for ledger picking (1-4)"),
  since_seq: z.number().optional().describe("Only return events after this seq"),
  wait_ms: z.number().optional().describe("Long-poll budget for the events action"),
  all: z.boolean().optional().describe("Include other managers' workers and events"),
  max_chars: z.number().optional().describe("Truncate result text to this many characters"),
  verdict: z.enum(["pass", "strike"]).optional().describe("Trial-ladder verdict for the model"),
  for_ms: z.number().optional().describe("Keep the worker alive this long"),
  level: z.enum(["debug", "info", "warn", "error"]).optional().describe("Minimum log level"),
  event: z.string().optional().describe("Substring filter on log event names"),
  limit: z.number().optional().describe("Maximum rows to return"),
  ledger_op: z.enum(["show", "import", "export"]).optional().describe("Ledger sub-operation"),
  confirm: z.boolean().optional().describe("Confirm a policy export write"),
};

export type ActionInput = z.infer<z.ZodObject<typeof actionShape>>;

/** Result of one action call: ok plus free-form fields. */
export interface ActionResult {
  ok: boolean;
  [key: string]: unknown;
}

const logger = createLogger({ module: "ocm.tool" });

const RESUME_PROMPT =
  "Continue the previous task from where it stopped. The previous worker stopped " +
  "(limit or failure); do not redo work already committed. Verify the current state " +
  "of the worktree first.";

const REQUIRED: Record<string, string[]> = {
  run: ["cwd", "prompt"],
  result: ["worker"],
  restart: ["worker"],
  verdict: ["worker", "verdict"],
  keep: ["worker"],
  release: ["worker"],
};

const TERMINAL: WorkerRecord["state"][] = ["done", "failed", "killed"];

const STATE_OUTCOME: Record<string, DispatchRecord["outcome"]> = {
  done: "done",
  failed: "failed",
  killed: "killed",
  stalled: "stalled",
};

const TIERS_HEADING = "## Speed and capability tiers";

type Req = Record<string, unknown>;
type Difficulty = 1 | 2 | 3 | 4;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrU = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const difficultyOf = (v: unknown): Difficulty | undefined =>
  v === 1 || v === 2 || v === 3 || v === 4 ? v : undefined;
const newRequestId = (): string => `req-${randomBytes(6).toString("hex")}`;

/** Memory snapshot or null when unreadable; OCM_MEMINFO exists so tests avoid /proc. */
function readMemoryOrLog(): MemoryInfo | null {
  try {
    return readMemory(process.env.OCM_MEMINFO ?? "/proc/meminfo");
  } catch (error) {
    logger.warn("tool.memory_unreadable", errorFields(error));
    return null;
  }
}

/** Memory launch guard; an unreadable meminfo never blocks a launch. */
function memoryGuard(): { allowed: boolean; reason?: string } {
  const info = readMemoryOrLog();
  if (info === null) return { allowed: true, reason: "memory could not be read; allowing launch" };
  return checkLaunchAllowed({ info });
}

/** Model ids with an active limit block, over the state's cleared map. */
function blockedModels(): string[] {
  const hits = collectHits({ logPath: process.env.OCM_OPENCODE_LOG });
  return currentBlocks(hits, new Date(), loadState().cleared).map(
    (block) => `${block.provider}/${block.model}`,
  );
}

/** Count of running workers per model, as pick() expects. */
function runningCounts(except?: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const worker of Object.values(loadState().workers)) {
    if (worker.state === "running" && worker.id !== except) {
      counts[worker.model] = (counts[worker.model] ?? 0) + 1;
    }
  }
  return counts;
}

/** Input/reason counts for an empty pick: why every candidate fell out. */
function noPickDetail(diff: Difficulty): string {
  const blocked = new Set(blockedModels());
  const entries = Object.values(loadLedger().models);
  const benched = entries.filter((entry) => entry.benched).length;
  const eligible = entries.filter((e) => !e.benched && e.maxDifficulty >= diff).length;
  const hit = entries.filter(
    (e) => !e.benched && e.maxDifficulty >= diff && blocked.has(e.id),
  ).length;
  let running = 0;
  for (const count of Object.values(runningCounts())) running += count;
  return (
    `considered ${entries.length}: ${benched} benched, ` +
    `${entries.length - benched - eligible} below D${diff}, ${hit} blocked; ` +
    `${running} workers running`
  );
}

/** Reaper effects whose events land in the shared monitor event log. */
function reaperDeps(): ReaperDeps {
  return defaultDeps((e) => {
    appendEvent({ worker: e.worker, owner: e.owner, kind: e.kind, detail: e.detail });
  });
}

/** True when the monitor saw a limit event for this worker. */
function hadLimitEvent(worker: string): boolean {
  return readEvents().some((e) => e.kind === "limit" && e.worker === worker);
}

/**
 * Append one dispatch for a terminal worker exactly once: usage comes from its
 * out file, a monitored limit wins as the outcome, and recordedAt is stamped.
 */
function recordOnce(record: WorkerRecord, now: Date, verdict?: "pass" | "strike"): void {
  if (record.recordedAt !== undefined) return;
  const usage = usageFromOutput(workerOutPath(record.id));
  const endedAt = record.endedAt ?? now.toISOString();
  recordDispatch({
    worker: record.id,
    ts: endedAt,
    model: record.model,
    ticket: record.ticket,
    difficulty: record.difficulty,
    wallSec: Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(record.startedAt)) / 1000)),
    costUsd: usage.costUsd,
    tokens: usage.tokens,
    outcome: hadLimitEvent(record.id) ? "limit" : (STATE_OUTCOME[record.state] ?? "done"),
    verdict,
  });
  updateState((state) => {
    // the record can only vanish if another writer raced the whole action flow
    state.workers[record.id].recordedAt = now.toISOString();
  });
}

/** Store the ticket difficulty on a freshly launched record. */
function stampDifficulty(id: string, difficulty: Difficulty): void {
  updateState((state) => {
    state.workers[id].difficulty = difficulty;
  });
}

/**
 * Handle one tool call. Never throws: exceptions are logged with errorFields
 * under a fresh request_id and turned into { ok:false, error, request_id }.
 */
export async function handleAction(input: ActionInput): Promise<ActionResult> {
  const startedAt = Date.now();
  const requestId = newRequestId();
  const req: Req = input !== null && typeof input === "object" ? (input as Req) : {};
  const action = str(req.action);
  let result: ActionResult;
  try {
    result = await validateThenRun(req, action);
  } catch (error) {
    const id = newRequestId();
    logger.error("tool.action_failed", { request_id: id, action, ...errorFields(error) });
    result = { ok: false, error: errMsg(error), request_id: id };
  }
  logger.info("tool.action", {
    request_id: typeof result.request_id === "string" ? result.request_id : requestId,
    manager: strOrU(req.manager),
    action: strOrU(req.action),
    duration_ms: Date.now() - startedAt,
    ok: result.ok,
  });
  return result;
}

/** Required-param gate, then the per-action dispatch. */
async function validateThenRun(req: Req, action: string): Promise<ActionResult> {
  if (action === "") return { ok: false, error: "action is required" };
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: `unknown action: ${String(req.action)}` };
  }
  if (strOrU(req.manager) === undefined) return { ok: false, error: `${action} needs manager` };
  for (const param of REQUIRED[action] ?? []) {
    if (strOrU(req[param]) === undefined) return { ok: false, error: `${action} needs ${param}` };
  }
  switch (action as (typeof ACTIONS)[number]) {
    case "run":
      return runTicket(req);
    case "ps":
      return { ok: true, workers: psRows(req.all === true ? undefined : str(req.manager)) };
    case "events":
      return eventsAction(req);
    case "result":
      return resultAction(req);
    case "restart":
      return ownerGuard(req) ?? restartAction(req);
    case "budget":
      return budgetAction();
    case "pick":
      return pickAction(req);
    case "verdict":
      return verdictAction(req);
    case "logs":
      return {
        ok: true,
        entries: readLogs({
          level: req.level as LogLevel | undefined,
          event: strOrU(req.event),
          worker: strOrU(req.worker),
          limit: num(req.limit),
        }),
      };
    case "keep": {
      const refused = ownerGuard(req);
      if (refused) return refused;
      keepWorker(str(req.worker), num(req.for_ms));
      return { ok: true };
    }
    case "release": {
      const refused = ownerGuard(req);
      if (refused) return refused;
      await releaseWorker(str(req.worker), reaperDeps());
      return { ok: true };
    }
    case "ledger":
      return ledgerAction(req);
    case "health":
      return healthAction();
  }
}

async function runTicket(req: Req): Promise<ActionResult> {
  const manager = str(req.manager);
  const diff = difficultyOf(req.difficulty) ?? 2;

  let model = str(req.model);
  let pickedBy: "caller" | "ledger" = "caller";
  if (model === "") {
    const picks = pick({ difficulty: diff, blocked: blockedModels(), running: runningCounts() });
    const best = picks[0];
    if (best === undefined) {
      logger.warn("tool.pick_empty", { manager, difficulty: diff });
      return {
        ok: false,
        error: `no model available for D${diff}`,
        detail: noPickDetail(diff),
      };
    }
    model = best.id;
    pickedBy = "ledger";
  }

  const guard = memoryGuard();
  if (!guard.allowed) {
    logger.warn("tool.memory_refused", { manager, reason: guard.reason });
    return { ok: false, status: "refused_memory", message: guard.reason };
  }

  const gate = checkLaunch(manager, model, { logPath: process.env.OCM_OPENCODE_LOG });
  if (gate.action === "warn") {
    logger.warn("tool.gate_warning", { manager, model, message: gate.message });
    return { ok: true, status: "warning", launched: false, message: gate.message };
  }
  if (gate.action === "refuse") {
    logger.warn("tool.gate_refused", { manager, model, message: gate.message });
    return { ok: false, status: "refused_limit", message: gate.message };
  }

  try {
    const launched = await launchWorker({
      owner: manager,
      cwd: str(req.cwd),
      model,
      prompt: str(req.prompt),
      ticket: strOrU(req.ticket),
    });
    stampDifficulty(launched.id, diff);
    logger.info("tool.started", { manager, id: launched.id, pid: launched.pid, model, pickedBy });
    return {
      ok: true,
      status: "started",
      launched: true,
      id: launched.id,
      pid: launched.pid,
      model,
      picked_by: pickedBy,
      repeat: gate.repeat === true,
    };
  } catch (error) {
    logger.warn("tool.launch_failed", { manager, model, ...errorFields(error) });
    return { ok: false, status: "refused", error: errMsg(error) };
  }
}

async function eventsAction(req: Req): Promise<ActionResult> {
  const events = await waitForEvents({
    owner: req.all === true ? undefined : str(req.manager),
    sinceSeq: num(req.since_seq),
    waitMs: num(req.wait_ms),
  });
  return {
    ok: true,
    events,
    next_seq: events.length > 0 ? Math.max(...events.map((e) => e.seq)) : (num(req.since_seq) ?? 0),
  };
}

function resultAction(req: Req): ActionResult {
  const worker = str(req.worker);
  const result = workerResult(worker, num(req.max_chars));
  return { ok: true, ...result, usage: usageFromOutput(workerOutPath(worker)) };
}

/**
 * Acting on another manager's worker needs all:true. Orphans belong to nobody, so any
 * manager may keep or release them. Unknown ids fall through to the action's own error.
 */
function ownerGuard(req: Req): ActionResult | undefined {
  const record = loadState().workers[str(req.worker)];
  if (record === undefined || req.all === true) return undefined;
  if (record.owner === str(req.manager) || record.owner === "orphan") return undefined;
  logger.warn("tool.not_owner", { worker: record.id, owner: record.owner, manager: req.manager });
  return {
    ok: false,
    status: "refused_owner",
    error: `worker ${record.id} belongs to ${record.owner}; pass all:true to act on it`,
  };
}

async function restartAction(req: Req): Promise<ActionResult> {
  const worker = str(req.worker);
  const previous = loadState().workers[worker];
  if (previous === undefined) return { ok: false, error: `unknown worker: ${worker}` };
  const guard = memoryGuard();
  if (!guard.allowed) {
    logger.warn("tool.restart_memory_refused", { worker, reason: guard.reason });
    return { ok: false, status: "refused_memory", message: guard.reason };
  }
  // choose the replacement BEFORE killing: with nothing to switch to, leave the worker running
  let model = str(req.model);
  if (model === "") {
    const best = pick({
      difficulty: previous.difficulty ?? 2,
      blocked: blockedModels(),
      exclude: [previous.model],
      running: runningCounts(previous.id),
    })[0];
    if (best === undefined) return { ok: false, error: "no replacement model available" };
    model = best.id;
  }
  const deps = reaperDeps();
  if (deps.isAlive(previous.pid)) {
    await deps.kill(previous.pid);
    logger.warn("tool.restart_killed", { worker, pid: previous.pid });
    // the pid is a real child raced by its own exit handler; another writer never
    // deletes it inside this action
    updateState((state) => {
      state.workers[worker].state = "killed";
      state.workers[worker].endedAt = new Date().toISOString();
      state.workers[worker].killReason = "restart";
    });
  }
  const launched = await launchWorker({
    owner: previous.owner,
    cwd: previous.cwd,
    model,
    ticket: previous.ticket,
    session: previous.session,
    prompt: str(req.prompt) || RESUME_PROMPT,
  });
  logger.info("tool.restarted", { worker, id: launched.id, previous: previous.model, model });
  return {
    ok: true,
    status: "restarted",
    id: launched.id,
    pid: launched.pid,
    model,
    previous: previous.id,
    previous_model: previous.model,
    resumed_session: previous.session ?? null,
  };
}

function budgetAction(): ActionResult {
  const now = new Date();
  const hits = collectHits({ logPath: process.env.OCM_OPENCODE_LOG });
  const blocks = currentBlocks(hits, now, loadState().cleared).map((block) => ({
    model: `${block.provider}/${block.model}`,
    kind: block.kind,
    since: block.since,
    resetAt: block.resetAt,
    raw: block.raw.slice(0, 200),
  }));
  logger.debug("tool.budget", { blocks: blocks.length });
  return { ok: true, blocks, memory: readMemoryOrLog() };
}

function pickAction(req: Req): ActionResult {
  const difficulty = difficultyOf(req.difficulty);
  if (difficulty === undefined) return { ok: false, error: `pick needs difficulty` };
  return {
    ok: true,
    picks: pick({ difficulty, blocked: blockedModels(), running: runningCounts() }),
  };
}

async function verdictAction(req: Req): Promise<ActionResult> {
  const verdict = str(req.verdict);
  if (verdict !== "pass" && verdict !== "strike") {
    return { ok: false, error: "verdict needs verdict" };
  }
  const worker = str(req.worker);
  const record = loadState().workers[worker];
  if (record === undefined) return { ok: false, error: `unknown worker: ${worker}` };
  const entry = applyVerdict(record.model, verdict);
  recordOnce(record, new Date(), verdict);
  logger.info("tool.verdict", { worker, model: record.model, verdict });
  return { ok: true, model: entry };
}

function ledgerAction(req: Req): ActionResult {
  const op = str(req.ledger_op) || "show";
  if (op === "show") {
    return {
      ok: true,
      models: Object.values(loadLedger().models).map((entry) => ({
        id: entry.id,
        pool: entry.pool,
        maxDifficulty: entry.maxDifficulty,
        passes: entry.passes,
        strikes: entry.strikes,
        benched: entry.benched,
        runs: entry.totals.runs,
        costUsd: entry.totals.costUsd,
      })),
    };
  }
  if (op === "import") {
    const markdown = readFileSync(policyPath(), "utf8");
    const imported = importPolicy(markdown);
    logger.info("tool.ledger_imported", { path: policyPath(), imported });
    return { ok: true, imported };
  }
  return exportExisting(req);
}

/** `~/.claude/model-policy.md` unless OCM_POLICY_PATH overrides it. */
function policyPath(): string {
  return process.env.OCM_POLICY_PATH ?? join(homedir(), ".claude", "model-policy.md");
}

function exportExisting(req: Req): ActionResult {
  const path = policyPath();
  const existing = readFileSync(path, "utf8");
  const next = exportPolicy(existing, loadLedger());
  if (req.confirm !== true) {
    return {
      ok: true,
      written: false,
      changed_rows: differingRows(existing, next),
      note: "pass confirm:true to write",
    };
  }
  const dir = join(dirname(path), "model-policy-history");
  const stamp = new Date().toISOString().slice(0, 10);
  let backup = join(dir, `${stamp}-pre-ocm-export.md`);
  for (let n = 2; existsSync(backup); n++) backup = join(dir, `${stamp}-pre-ocm-export-${n}.md`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(backup, existing);
  writeFileSync(path, next);
  logger.info("tool.ledger_exported", { path, backup });
  return { ok: true, written: true, backup };
}

/** Rows of the tiers markdown table, trimmed, separators dropped. */
function tableRows(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(TIERS_HEADING));
  const rows: string[] = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("|") && /[^:|\- ]/.test(trimmed)) rows.push(trimmed);
  }
  return rows;
}

/** Count of positions where the tiers table differs between old and new doc. */
function differingRows(existing: string, next: string): number {
  const before = tableRows(existing);
  const after = tableRows(next);
  let count = 0;
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (before[i] !== after[i]) count += 1;
  }
  return count;
}

function healthAction(): ActionResult {
  const counts: Record<string, number> = {};
  for (const worker of Object.values(loadState().workers)) {
    counts[worker.state] = (counts[worker.state] ?? 0) + 1;
  }
  return {
    ok: true,
    version: "1.0.0",
    uptime_s: Math.round(process.uptime()),
    workers: counts,
    memory: readMemoryOrLog(),
    state_dir: stateDir(),
    log: serverLogPath(),
  };
}

/** Record-end helper for tick step 3: every terminal, unrecorded worker. */
function recordEnded(at: Date): void {
  for (const record of Object.values(loadState().workers)) {
    if (!TERMINAL.includes(record.state) || record.recordedAt !== undefined) continue;
    try {
      recordOnce(record, at);
    } catch (error) {
      logger.error("tool.tick.record_one_failed", { worker: record.id, ...errorFields(error) });
    }
  }
}

/** Run one tick step so one failure never stops the others. */
async function safe(event: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error(event, errorFields(error));
  }
}

/**
 * Background heartbeat T8b calls every few seconds: sweep worker state, run
 * one reaper pass (events feed the monitor), then record dispatches for
 * terminal workers exactly once.
 */
export async function tick(now?: Date): Promise<void> {
  const at = now ?? new Date();
  await safe("tool.tick.sweep_failed", () => sweep(at));
  await safe("tool.tick.reap_failed", async () => {
    await reapStep(reaperDeps(), at);
    adoptOrphans(reaperDeps(), at);
  });
  await safe("tool.tick.record_failed", () => recordEnded(at));
}

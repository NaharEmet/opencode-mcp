import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { workersDir } from "./evidence.js";
import { createLogger, errorFields } from "./log.js";
import { updateState, upsertWorker } from "./state.js";

/** Request to start one detached `opencode run` worker. */
export interface LaunchRequest {
  owner: string;
  cwd: string;
  model: string;
  prompt: string;
  ticket?: string;
  session?: string;
}

/** Spawn handle for a worker whose output lives under the state logs. */
export interface LaunchResult {
  id: string;
  pid: number;
  model: string;
  cwd: string;
  outPath: string;
}

const log = createLogger({ module: "launch" });

/** Stdout capture file (`<id>.out.jsonl`) for a worker id. */
export function workerOutPath(id: string): string {
  return join(workersDir(), `${id}.out.jsonl`);
}

/** Directory every worker cwd must live in: OCM_ALLOWED_ROOT else ~/Documents/code. */
export function allowedRoot(): string {
  const fromEnv = process.env.OCM_ALLOWED_ROOT;
  return fromEnv ?? join(homedir(), "Documents", "code");
}

function refuse(reason: string): never {
  log.warn("worker.launch_refused", { reason });
  throw new Error(`refused: ${reason}`);
}

/** Strip the internal `oc-` alias and require exactly `provider/model`. */
function validateModel(requested: string): string {
  const model = requested.startsWith("oc-") ? requested.slice(3) : requested;
  if (model !== requested) {
    log.debug("worker.model_alias", { requested, model });
  }
  const parts = model.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    refuse(`model must be provider/model, got: ${requested}`);
  }
  return model;
}

function realRoot(): string {
  try {
    return realpathSync(allowedRoot());
  } catch (error) {
    log.error("worker.root_unreadable", { root: allowedRoot(), ...errorFields(error) });
    refuse(`allowed root is not readable: ${allowedRoot()}`);
  }
}

/** Reject anything that is not an existing directory inside realpath(allowedRoot()). */
function validateCwd(cwd: string): void {
  const rootReal = realRoot();
  if (!isAbsolute(cwd)) refuse(`cwd must be absolute: ${cwd}`);
  if (!existsSync(cwd)) refuse(`cwd does not exist: ${cwd}`);
  if (!statSync(cwd).isDirectory()) refuse(`cwd is not a directory: ${cwd}`);
  const real = realpathSync(cwd);
  if (real !== rootReal && !real.startsWith(`${rootReal}${sep}`)) {
    refuse(`cwd ${real} is outside the allowed root ${rootReal}`);
  }
}

/**
 * Start one detached `opencode run` worker: validate the request, spawn it with
 * stdout/stderr captured on disk so the output survives a server restart, and
 * record it in the persistent state. The parent never waits on the child.
 */
export async function launchWorker(req: LaunchRequest): Promise<LaunchResult> {
  if (req.owner === "") refuse("owner is required");
  if (req.prompt === "") refuse("prompt is required");
  const model = validateModel(req.model);
  validateCwd(req.cwd);

  // The id embeds the pid, which only exists after spawn, so capture into
  // pending files first; an append fd keeps writing to the inode through the
  // rename to the final `<id>.*` names.
  // random suffix: two launches in the same millisecond must not share pending files
  const pendingKey = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const ts36 = Date.now().toString(36);
  mkdirSync(workersDir(), { recursive: true });
  const pendingOut = join(workersDir(), `${pendingKey}.pending.out.jsonl`);
  const pendingErr = join(workersDir(), `${pendingKey}.pending.err.log`);
  const outFd = openSync(pendingOut, "a");
  const errFd = openSync(pendingErr, "a");
  const bin = process.env.OCM_OPENCODE_BIN ?? "opencode";
  // resumed workers carry --session so the replacement continues the prior session
  const argv = [
    "run",
    "-m",
    model,
    "--auto",
    "--format",
    "json",
    ...(req.session === undefined ? [] : ["--session", req.session]),
    req.prompt,
  ];
  // never pass --dir: opencode 2.2.5 rejects it; req.cwd pins the directory
  const child = spawn(bin, argv, {
    cwd: req.cwd,
    detached: true,
    stdio: ["ignore", outFd, errFd],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    closeSync(outFd);
    closeSync(errFd);
    unlinkSync(pendingOut);
    unlinkSync(pendingErr);
    log.error("worker.spawn_failed", { bin, cwd: req.cwd, ...errorFields(error) });
    throw error;
  }

  // the spawn event just fired, so child.pid exists; the type cannot see it
  const pid = child.pid as number;
  const id = `${ts36}-${pid}`;
  const outPath = workerOutPath(id);
  renameSync(pendingOut, outPath);
  renameSync(pendingErr, join(workersDir(), `${id}.err.log`));
  closeSync(outFd);
  closeSync(errFd);
  child.unref();
  upsertWorker({
    id,
    pid,
    owner: req.owner,
    ticket: req.ticket,
    model,
    cwd: req.cwd,
    session: req.session,
    startedAt: new Date().toISOString(),
    state: "running",
  });
  child.once("exit", (code, signal) => onExit(id, code, signal));
  log.info("worker.launch", {
    id,
    pid,
    owner: req.owner,
    ticket: req.ticket,
    session: req.session,
    model,
    cwd: req.cwd,
    argv: [
      "run",
      "-m",
      model,
      "--auto",
      "--format",
      "json",
      ...(req.session === undefined ? [] : ["--session", req.session]),
      `${req.prompt.length} chars starting ${JSON.stringify(req.prompt.slice(0, 120))}`,
    ],
    outPath,
  });
  return { id, pid, model, cwd: req.cwd, outPath };
}

/** Terminal handler: map exit to a persisted state; failures here never throw. */
function onExit(id: string, code: number | null, signal: string | null): void {
  const state = signal !== null ? "killed" : code === 0 ? "done" : "failed";
  try {
    let missing = false;
    updateState((s) => {
      const worker = s.workers[id];
      if (worker === undefined) {
        missing = true;
        return;
      }
      worker.state = state;
      worker.endedAt = new Date().toISOString();
      worker.exitCode = code ?? undefined;
    });
    // the record can be gone when state was reset mid-run; nothing left to update
    if (missing) log.warn("worker.exit_record_missing", { id, code, signal, state });
    else log[state === "done" ? "info" : "warn"]("worker.exit", { id, code, signal, state });
  } catch (error) {
    log.error("worker.exit_update_failed", { id, ...errorFields(error) });
  }
}

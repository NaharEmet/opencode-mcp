import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchRequest } from "../../../src/modules/ocm/launch.js";
import { allowedRoot, launchWorker, workerOutPath } from "../../../src/modules/ocm/launch.js";
import type { LogEntry } from "../../../src/modules/ocm/log.js";
import { readLogs, stateDir } from "../../../src/modules/ocm/log.js";
import { loadState, updateState } from "../../../src/modules/ocm/state.js";

const NODE_DIR = dirname(process.execPath);
const OK_ARGS = ["run", "-m", "openai/gpt-6-luna", "--auto", "--format", "json", "do the ticket"];
// fake bin echoing its argv as the only stdout line, exit code via FAKE_EXIT
const CAPTURE =
  `process.stdout.write(JSON.stringify(process.argv.slice(2)));` +
  `process.exit(Number(process.env.FAKE_EXIT ?? "0"));`;
const SLOW = "setTimeout(() => process.exit(0), 3000);";

type Entry = LogEntry & { id?: string; state?: string };

let base: string;
let root: string;
let binsDir: string;
let savedPath: string | undefined;

function bin(name: string, script: string): string {
  const path = join(binsDir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

function req(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    owner: "owen",
    cwd: root,
    model: "openai/gpt-6-luna",
    prompt: "do the ticket",
    ...overrides,
  };
}

function record(id: string) {
  return loadState().workers[id];
}

function logsAt(event: string, level?: "debug" | "info" | "warn" | "error"): Entry[] {
  return readLogs(level === undefined ? { event } : { event, level }) as Entry[];
}

async function until(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function refused(overrides: Partial<LaunchRequest>): Promise<void> {
  await expect(launchWorker({ ...req(), ...overrides })).rejects.toThrow(/^refused:/);
  expect(Object.keys(loadState().workers)).toEqual([]);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ocm-launch-"));
  root = join(base, "root");
  mkdirSync(root);
  binsDir = join(base, "bins");
  mkdirSync(binsDir);
  process.env.OCM_STATE_DIR = join(base, "state");
  process.env.OCM_ALLOWED_ROOT = root;
  process.env.OCM_OPENCODE_BIN = bin("fake", CAPTURE);
  savedPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = savedPath;
  for (const name of ["OCM_STATE_DIR", "OCM_ALLOWED_ROOT", "OCM_OPENCODE_BIN", "FAKE_EXIT"]) {
    delete process.env[name];
  }
  rmSync(base, { recursive: true, force: true });
});

describe("allowedRoot", () => {
  it("prefers OCM_ALLOWED_ROOT and falls back to ~/Documents/code", () => {
    expect(allowedRoot()).toBe(root);
    delete process.env.OCM_ALLOWED_ROOT;
    expect(allowedRoot()).toBe(join(homedir(), "Documents", "code"));
  });
});

describe("launchWorker refusals", () => {
  it("refuses an empty owner or prompt", async () => {
    await refused({ owner: "" });
    await refused({ prompt: "" });
  });

  it("refuses a model that is not provider/model", async () => {
    await refused({ model: "noslash" });
    await refused({ model: "a/b/c" });
  });

  it("refuses a relative, missing, or non-directory cwd", async () => {
    await refused({ cwd: "work" });
    await refused({ cwd: join(root, "missing") });
    writeFileSync(join(root, "file.txt"), "x");
    await refused({ cwd: join(root, "file.txt") });
  });

  it("refuses a cwd outside the allowed root, including prefix look-alikes", async () => {
    mkdirSync(join(base, "outside"));
    await refused({ cwd: join(base, "outside") });
    const evil = mkdirSync(join(`${root}-evil`, "work"), { recursive: true });
    await refused({ cwd: evil });
  });

  it("refuses when the allowed root itself does not exist", async () => {
    process.env.OCM_ALLOWED_ROOT = join(base, "gone");
    await refused({});
  });
});

describe("launchWorker spawn", () => {
  it("launches a detached worker, captures argv on disk, and persists the record", async () => {
    const work = join(root, "work");
    mkdirSync(work);
    const result = await launchWorker(req({ cwd: work }));
    expect(result.id).toMatch(/^[a-z0-9]+-\d+$/);
    expect(result.pid).toBeGreaterThan(0);
    expect(result.cwd).toBe(work);
    expect(result.outPath).toBe(workerOutPath(result.id));

    const rec = record(result.id);
    expect(rec?.owner).toBe("owen");
    expect(rec?.pid).toBe(result.pid);
    expect(rec?.model).toBe("openai/gpt-6-luna");
    expect(rec?.cwd).toBe(work);
    expect(rec?.startedAt).toBeDefined();
    expect(rec?.state).toBe("running");

    await until("state done", () => record(result.id)?.state === "done");
    expect(record(result.id)?.exitCode).toBe(0);
    expect(existsSync(join(stateDir(), "logs", "workers", `${result.id}.err.log`))).toBe(true);

    await until("stdout has argv", () => readFileSync(result.outPath, "utf8").length > 0);
    const args = JSON.parse(readFileSync(result.outPath, "utf8")) as string[];
    expect(args).toEqual(OK_ARGS);
    expect(args).not.toContain("--dir");

    const launchEntry = logsAt("worker.launch", "info").find((e) => e.id === result.id);
    expect(launchEntry?.outPath).toBe(result.outPath);
    expect(launchEntry?.pid).toBe(result.pid);
    const exitEntry = logsAt("worker.exit", "info").find((e) => e.id === result.id);
    expect(exitEntry?.state).toBe("done");
  });

  it("strips a leading oc- model alias and allows the root itself as cwd", async () => {
    const result = await launchWorker(req({ model: "oc-openai/x", cwd: root }));
    await until("state done", () => record(result.id)?.state === "done");
    expect(record(result.id)?.model).toBe("openai/x");
    await until("stdout has argv", () => readFileSync(result.outPath, "utf8").length > 0);
    expect(readFileSync(result.outPath, "utf8")).toContain('"-m","openai/x"');
  });

  it("passes --session into the argv and records it on the worker", async () => {
    const result = await launchWorker(req({ session: "ses_prev", cwd: root }));
    expect(record(result.id)?.session).toBe("ses_prev");
    await until("state done", () => record(result.id)?.state === "done");
    await until("stdout has argv", () => readFileSync(result.outPath, "utf8").length > 0);
    const args = JSON.parse(readFileSync(result.outPath, "utf8")) as string[];
    expect(args).toEqual([...OK_ARGS.slice(0, 6), "--session", "ses_prev", "do the ticket"]);
  });

  it("maps a nonzero exit to failed and logs the exit at warn", async () => {
    process.env.FAKE_EXIT = "3";
    const result = await launchWorker(req());
    await until("failed", () => record(result.id)?.state === "failed");
    expect(record(result.id)?.exitCode).toBe(3);
    expect(record(result.id)?.endedAt).toBeDefined();
    expect(logsAt("worker.exit", "warn").some((e) => e.id === result.id)).toBe(true);
  });

  it("maps a signal to killed", async () => {
    process.env.OCM_OPENCODE_BIN = bin("slow", SLOW);
    const result = await launchWorker(req());
    await until("running", () => record(result.id)?.state === "running");
    process.kill(result.pid, "SIGTERM");
    await until("killed", () => record(result.id)?.state === "killed");
    expect(record(result.id)?.exitCode).toBeUndefined();
    expect(logsAt("worker.exit", "warn").some((e) => e.id === result.id)).toBe(true);
  });

  it("throws, records nothing, and spills no pending files when the binary is missing", async () => {
    process.env.OCM_OPENCODE_BIN = join(binsDir, "missing");
    const caught: unknown = await launchWorker(req()).catch((error) => error);
    expect((caught as Error).message).toContain("ENOENT");
    expect(Object.keys(loadState().workers)).toEqual([]);
    expect(logsAt("worker.spawn_failed", "error").length).toBeGreaterThanOrEqual(1);
    expect(readdirSync(join(stateDir(), "logs", "workers"))).toEqual([]);
  });

  it("logs but never throws when the record vanished before exit", async () => {
    process.env.OCM_OPENCODE_BIN = bin("slow", SLOW);
    const result = await launchWorker(req());
    await until("running", () => record(result.id)?.state === "running");
    updateState((s) => {
      delete s.workers[result.id];
    });
    process.kill(result.pid, "SIGTERM");
    await until("exit_update_failed", () =>
      logsAt("worker.exit_update_failed", "error").some((e) => e.id === result.id),
    );
    expect(record(result.id)).toBeUndefined();
  });

  it("falls back to `opencode` on the PATH when OCM_OPENCODE_BIN is unset", async () => {
    delete process.env.OCM_OPENCODE_BIN;
    process.env.PATH = `${binsDir}:${NODE_DIR}`;
    bin("opencode", CAPTURE);
    const work = join(root, "path-work");
    mkdirSync(work);
    const result = await launchWorker(req({ cwd: work }));
    await until("state done", () => record(result.id)?.state === "done");
    const args = JSON.parse(readFileSync(result.outPath, "utf8")) as string[];
    expect(args.slice(-5)).toEqual(OK_ARGS.slice(-5));
    expect(args).not.toContain("--dir");
  });
});

describe("concurrent launches", () => {
  it("do not share capture files when started in the same millisecond", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const [a, b] = await Promise.all([launchWorker(req()), launchWorker(req())]);
    now.mockRestore();
    expect(a.outPath).not.toBe(b.outPath);
    expect(a.id).not.toBe(b.id);
  });
});

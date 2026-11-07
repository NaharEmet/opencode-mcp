import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchWorker, workerOutPath } from "../../../src/modules/ocm/launch.js";
import {
  importPolicy,
  loadLedger,
  poolOf,
  recordDispatch,
} from "../../../src/modules/ocm/ledger.js";
import { type LogEntry, readLogs, serverLogPath, stateDir } from "../../../src/modules/ocm/log.js";
import { appendEvent, readEvents } from "../../../src/modules/ocm/monitor.js";
import * as reaper from "../../../src/modules/ocm/reaper.js";
import { loadState, upsertWorker, type WorkerRecord } from "../../../src/modules/ocm/state.js";
import {
  type ActionInput,
  type ActionResult,
  handleAction,
  tick,
} from "../../../src/modules/ocm/tool.js";
import { VERSION } from "../../../src/modules/ocm/version.js";

const MODEL = "openai/gpt-6-luna";
const ZAI = "zai-coding-plan/glm-5.3-flash";
const ENVS = [
  "OCM_STATE_DIR",
  "OCM_ALLOWED_ROOT",
  "OCM_OPENCODE_BIN",
  "OCM_OPENCODE_LOG",
  "OCM_POLICY_PATH",
  "OCM_MEMINFO",
  "OCM_LIMIT_MODE",
  "OCM_BUDGETS",
  "OCM_LOG_LEVEL",
  "OCM_MIN_AVAILABLE_MB",
  "FAKE_EXIT",
];
// fake bin echoing its argv as the only stdout line, exit code via FAKE_EXIT
const CAPTURE =
  `process.stdout.write(JSON.stringify(process.argv.slice(2)));` +
  `process.exit(Number(process.env.FAKE_EXIT ?? "0"));`;
const SLOW = "setTimeout(() => process.exit(0), 3000);";

let base: string;
let root: string;
let binsDir: string;
let logFile: string;

function bin(name: string, script: string): string {
  const path = join(binsDir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function until(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function call(input: Record<string, unknown> | null): Promise<ActionResult> {
  return handleAction({ manager: "maya", ...input } as unknown as ActionInput);
}

function rec(id: string, model: string, over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id,
    pid: 999999999,
    owner: "maya",
    model,
    cwd: root,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    state: "running",
    ...over,
  };
}

function meminfo(availableKb: number): void {
  const path = join(base, "meminfo");
  writeFileSync(path, `MemTotal: 8000000 kB\nMemAvailable: ${availableKb} kB\n`);
  process.env.OCM_MEMINFO = path;
}

function tierRow(
  id: string,
  speed: string,
  strength: string,
  difficulty: number,
  trial: string,
): string {
  return `| \`${id}\` | ${speed} | ${strength} | D${difficulty} | ${trial} |  |`;
}

function tiersOnlyDoc(rows: string[]): string {
  return [
    "# Model policy",
    "",
    "## Speed and capability tiers",
    "",
    "| model | speed | strength | tier | trial | notes |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function tiersWithPoolsDoc(rows: string[]): string {
  return [
    ...tiersOnlyDoc(rows).split("\n"),
    "## Three pools",
    "",
    "| pool | models |",
    "| --- | --- |",
    "| free | `opencode/sonoma-free` |",
    "",
  ].join("\n");
}

function hitLine(error: string, ts: string): string {
  return (
    `timestamp=${ts} level=ERROR run=4f55e49a message=\\"stream error\\" ` +
    `providerID=zai-coding-plan modelID=glm-5.3-flash session.id=ses_x small=false agent=build ` +
    `mode=primary error.error=\\"AI_APICallError: ${error}\\"`
  );
}

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function dispatchLines(): Record<string, unknown>[] {
  return readFileSync(join(stateDir(), "dispatches.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function argvOf(id: string): Promise<string[]> {
  const out = workerOutPath(id);
  await until("argv written", () => {
    try {
      return readFileSync(out, "utf8").length > 0;
    } catch {
      return false;
    }
  });
  return JSON.parse(readFileSync(out, "utf8")) as string[];
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ocm-tool-"));
  root = join(base, "root");
  mkdirSync(root);
  binsDir = join(base, "bins");
  mkdirSync(binsDir);
  logFile = join(base, "opencode.log");
  process.env.OCM_STATE_DIR = join(base, "state");
  process.env.OCM_ALLOWED_ROOT = root;
  process.env.OCM_OPENCODE_BIN = bin("fake", CAPTURE);
  process.env.OCM_POLICY_PATH = join(base, "policy.md");
  process.env.OCM_OPENCODE_LOG = logFile; // never read the real opencode log; absent until a test writes it
  meminfo(8_000_000);
});

afterEach(() => {
  for (const name of ENVS) delete process.env[name];
  rmSync(base, { recursive: true, force: true });
});

describe("run", () => {
  it("picks a model from the ledger and records the difficulty", async () => {
    importPolicy(
      tiersOnlyDoc([tierRow("opencode/sonoma-free", "medium", "light", 2, "0 pass / 0 strike")]),
    );
    const res = await call({ action: "run", cwd: root, prompt: "do the ticket", ticket: "t1" });
    expect(res).toMatchObject({
      ok: true,
      status: "started",
      launched: true,
      model: "opencode/sonoma-free",
      picked_by: "ledger",
      repeat: false,
    });
    const id = res.id as string;
    expect(await argvOf(id)).toContain("opencode/sonoma-free");
    expect(loadState().workers[id]?.difficulty).toBe(2);
  });

  it("uses an explicit model as caller pick", async () => {
    const res = await call({ action: "run", cwd: root, prompt: "do it", model: MODEL });
    expect(res).toMatchObject({ ok: true, status: "started", model: MODEL, picked_by: "caller" });
    const args = await argvOf(res.id as string);
    expect(args.at(-1)).toBe("do it");
  });

  it("explains why nothing qualified", async () => {
    const res = await call({ action: "run", cwd: root, prompt: "work" });
    expect(res).toMatchObject({ ok: false, error: "no model available for D2" });
    expect(String(res.detail)).toContain("considered 0");
  });

  it("counts blocked models in the reason detail", async () => {
    process.env.OCM_OPENCODE_LOG = logFile;
    writeFileSync(logFile, `${hitLine("Rate limit exceeded", iso(1))}\n`);
    importPolicy(tiersOnlyDoc([tierRow(ZAI, "fast", "light", 3, "0 pass / 0 strike")]));
    upsertWorker(rec("rw", MODEL));
    const res = await call({ action: "run", cwd: root, prompt: "work" });
    expect(res.ok).toBe(false);
    expect(String(res.detail)).toContain("1 blocked");
    expect(String(res.detail)).toContain("1 workers running");
  });

  it("refuses when memory is below the minimum", async () => {
    meminfo(1000);
    const res = await call({ action: "run", cwd: root, prompt: "work", model: MODEL });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("refused_memory");
    expect(String(res.message)).toContain("below the 2048 MB minimum");
  });

  it("fails open when memory cannot be read", async () => {
    process.env.OCM_MEMINFO = join(base, "gone");
    const res = await call({ action: "run", cwd: root, prompt: "work", model: MODEL });
    expect(res).toMatchObject({ ok: true, status: "started" });
  });

  it("warns once, then launches the identical repeat", async () => {
    process.env.OCM_OPENCODE_LOG = logFile;
    writeFileSync(logFile, `${hitLine("Usage limit reached for 5 hour", iso(1))}\n`);
    const first = await call({ action: "run", cwd: root, prompt: "work again", model: ZAI });
    expect(first).toMatchObject({ ok: true, status: "warning", launched: false });
    expect(String(first.message)).toContain("Repeat the same run within 10 minutes");
    const second = await call({ action: "run", cwd: root, prompt: "work again", model: ZAI });
    expect(second).toMatchObject({ ok: true, status: "started", launched: true, repeat: true });
    expect(Object.keys(loadState().workers)).toHaveLength(1);
  });

  it("refuses when the limit mode is refuse", async () => {
    process.env.OCM_LIMIT_MODE = "refuse";
    process.env.OCM_OPENCODE_LOG = logFile;
    writeFileSync(logFile, `${hitLine("Insufficient account funds", iso(1))}\n`);
    const res = await call({ action: "run", cwd: root, prompt: "work", model: ZAI });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("refused_limit");
    expect(String(res.message)).toContain("REFUSED");
  });

  it("reports a launcher refusal as status refused", async () => {
    process.env.OCM_OPENCODE_BIN = join(binsDir, "missing");
    const res = await call({ action: "run", cwd: root, prompt: "work", model: MODEL });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("refused");
    expect(String(res.error)).toContain("ENOENT");
  });
});

describe("ps", () => {
  it("filters by manager unless all is set", async () => {
    upsertWorker(rec("wm", MODEL));
    upsertWorker(rec("wo", MODEL, { owner: "owen" }));
    const mine = await call({ action: "ps" });
    expect(mine.workers).toHaveLength(1);
    const all = await call({ action: "ps", all: true });
    expect(all.workers).toHaveLength(2);
  });
});

describe("events", () => {
  it("returns new events with the next seq", async () => {
    appendEvent({ worker: "w1", owner: "maya", kind: "first_response" });
    const res = await call({ action: "events", wait_ms: 100 });
    expect(res.ok).toBe(true);
    expect(res.events).toHaveLength(1);
    expect(res.next_seq).toBe(1);
    const later = await call({ action: "events", since_seq: 99, wait_ms: 10 });
    expect(later.events).toEqual([]);
    expect(later.next_seq).toBe(99);
  });

  it("returns all owners' events when all is set", async () => {
    const none = await call({ action: "events", wait_ms: 10 });
    expect(none.events).toEqual([]);
    expect(none.next_seq).toBe(0);
    appendEvent({ worker: "w1", owner: "maya", kind: "first_response" });
    appendEvent({ worker: "w2", owner: "owen", kind: "first_response" });
    const res = await call({ action: "events", wait_ms: 100 });
    expect(res.events).toHaveLength(1);
    const all = await call({ action: "events", wait_ms: 100, all: true, since_seq: 0 });
    expect(all.events).toHaveLength(2);
    expect(all.next_seq).toBe(2);
  });
});

describe("result", () => {
  it("returns the text snapshot plus usage from the out file", async () => {
    mkdirSync(join(stateDir(), "logs", "workers"), { recursive: true });
    writeFileSync(
      workerOutPath("w1"),
      [
        JSON.stringify({ type: "text", part: { text: "hello" } }),
        JSON.stringify({ type: "text", part: { text: " world" } }),
        JSON.stringify({
          type: "step_finish",
          part: {
            cost: 0.25,
            tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        }),
      ].join("\n"),
    );
    upsertWorker(rec("w1", MODEL, { state: "done", endedAt: iso(1) }));
    const res = await call({ action: "result", worker: "w1" });
    expect(res).toMatchObject({ ok: true, state: "done", text: "hello\n world", truncated: false });
    expect(res.usage).toMatchObject({ costUsd: 0.25, tokens: { input: 7, output: 3 } });
    const capped = await call({ action: "result", worker: "w1", max_chars: 5 });
    expect(capped).toMatchObject({ ok: true, text: "world", truncated: true });
  });

  it("errors on an unknown worker", async () => {
    const res = await call({ action: "result", worker: "ghost" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("unknown worker: ghost");
  });
});

describe("restart", () => {
  it("kills an alive worker, picks a replacement, and resumes the session", async () => {
    process.env.OCM_OPENCODE_BIN = bin("slow", SLOW);
    importPolicy(
      tiersOnlyDoc([
        tierRow("opencode/sonoma-free", "medium", "light", 2, "0 pass / 0 strike"),
        tierRow(MODEL, "fast", "strong", 3, "1 pass / 0 strike"),
      ]),
    );
    const old = await launchWorker({
      owner: "maya",
      cwd: root,
      model: MODEL,
      prompt: "do t1",
      session: "ses_prev",
    });
    await until("worker running", () => loadState().workers[old.id]?.state === "running");
    // the replacement must use the argv-capturing bin, not the slow one
    process.env.OCM_OPENCODE_BIN = bin("capture", CAPTURE);
    const res = await call({ action: "restart", worker: old.id });
    expect(res).toMatchObject({
      ok: true,
      status: "restarted",
      model: "opencode/sonoma-free",
      previous: old.id,
      previous_model: MODEL,
      resumed_session: "ses_prev",
    });
    await until("old killed", () => loadState().workers[old.id]?.killReason === "restart");
    expect(loadState().workers[old.id]?.state).toBe("killed");
    const args = await argvOf(res.id as string);
    expect(args).toContain("--session");
    expect(args).toContain("ses_prev");
    expect(String(args.at(-1))).toContain("Continue the previous task");
  });

  it("relaunches with an explicit model and prompt when the pid is gone", async () => {
    importPolicy(tiersOnlyDoc([tierRow(ZAI, "fast", "light", 3, "0 pass / 0 strike")]));
    upsertWorker(rec("w2", MODEL));
    const res = await call({
      action: "restart",
      worker: "w2",
      model: ZAI,
      prompt: "try again",
    });
    expect(res).toMatchObject({ ok: true, status: "restarted", model: ZAI, resumed_session: null });
    const args = await argvOf(res.id as string);
    expect(args.at(-1)).toBe("try again");
    expect(args).not.toContain("--session");
  });

  it("fails when no replacement model is available", async () => {
    upsertWorker(rec("w3", MODEL));
    const res = await call({ action: "restart", worker: "w3" });
    expect(res).toEqual({ ok: false, error: "no replacement model available" });
    expect(Object.keys(loadState().workers)).toEqual(["w3"]);
  });

  it("errors for an unknown worker and on memory refusal", async () => {
    const missing = await call({ action: "restart", worker: "ghost" });
    expect(missing).toEqual({ ok: false, error: "unknown worker: ghost" });
    meminfo(1000);
    upsertWorker(rec("w4", MODEL));
    const blocked = await call({ action: "restart", worker: "w4" });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe("refused_memory");
  });
});

describe("budget", () => {
  it("lists active blocks and the memory snapshot", async () => {
    process.env.OCM_OPENCODE_LOG = logFile;
    writeFileSync(logFile, `${hitLine("Usage limit reached for 5 hour", iso(1))}\n`);
    const res = await call({ action: "budget" });
    const blocks = res.blocks as Array<{
      model: string;
      kind: string;
      resetAt: string | undefined;
      raw: string;
    }>;
    expect(blocks).toEqual([
      expect.objectContaining({ model: ZAI, kind: "five_hour", resetAt: undefined }),
    ]);
    expect(blocks[0].raw.length).toBeLessThanOrEqual(200);
    expect(res.memory).toMatchObject({ totalMb: 7812, availableMb: 7812 });
  });

  it("reports spend and budget status, warning when a cap is crossed", async () => {
    process.env.OCM_LOG_LEVEL = "debug";
    process.env.OCM_BUDGETS = `${poolOf(MODEL)}:5h:0.1`;
    recordDispatch({
      worker: "b1",
      ts: new Date().toISOString(),
      model: MODEL,
      wallSec: 1,
      costUsd: 0.2,
      tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      outcome: "done",
    });
    const res = await call({ action: "budget" });
    const pool = poolOf(MODEL);
    expect((res.spend as Record<string, Record<string, unknown>>).total[pool]).toMatchObject({
      runs: 1,
    });
    expect(res.budgets).toEqual([expect.objectContaining({ pool, window: "5h", level: "over" })]);
    expect(readLogs({ event: "tool.budget_threshold" })).toHaveLength(1);
  });

  it("lists a provider-wide block from an unattributed session line", async () => {
    writeFileSync(
      logFile,
      `timestamp=${iso(1)} level=ERROR message="Failed to drain Session" cause="AI.Error: ` +
        `Weekly/Monthly Limit Exhausted. Your limit will reset at 2099-11-10 02:02:55" ` +
        "role=server sessionID=ses_unknown\n",
    );
    const res = await call({ action: "budget" });
    expect(res.blocks).toEqual([
      expect.objectContaining({ model: "zai-coding-plan/*", kind: "weekly_monthly" }),
    ]);
    // the wall also keeps every model of that provider out of pick
    importPolicy(tiersOnlyDoc([tierRow(ZAI, "fast", "strong", 3, "1 pass / 0 strike")]));
    expect((await call({ action: "pick", difficulty: 3 })).picks).toEqual([]);
  });
});

describe("pick", () => {
  it("ranks qualifying ledger models", async () => {
    importPolicy(
      tiersOnlyDoc([
        tierRow("opencode/sonoma-free", "medium", "light", 2, "0 pass / 0 strike"),
        tierRow(MODEL, "fast", "strong", 3, "1 pass / 0 strike"),
      ]),
    );
    const res = await call({ action: "pick", difficulty: 2 });
    expect((res.picks as Array<{ id: string; pool: string }>)[0]).toMatchObject({
      id: "opencode/sonoma-free",
      pool: "free",
    });
    const d3 = await call({ action: "pick", difficulty: 3 });
    expect((d3.picks as Array<{ id: string }>)[0].id).toBe(MODEL);
    expect((await call({ action: "pick", difficulty: 4 })).picks).toEqual([]);
  });

  it("needs a valid difficulty", async () => {
    const missing = await call({ action: "pick" });
    expect(missing).toEqual({ ok: false, error: "pick needs difficulty" });
    const invalid = await call({ action: "pick", difficulty: "easy" });
    expect(invalid).toEqual({ ok: false, error: "pick needs difficulty" });
  });
});

describe("verdict", () => {
  it("applies verdicts and records one dispatch per worker", async () => {
    importPolicy(tiersOnlyDoc([tierRow(MODEL, "fast", "strong", 2, "0 pass / 0 strike")]));
    mkdirSync(join(stateDir(), "logs", "workers"), { recursive: true });
    writeFileSync(
      workerOutPath("wv"),
      `${JSON.stringify({ type: "step_finish", part: { cost: 0.5, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } })}\n`,
    );
    upsertWorker(rec("wv", MODEL, { state: "running" }));
    upsertWorker(rec("wk", MODEL, { state: "killed" }));
    upsertWorker(rec("ws", MODEL, { state: "stalled" }));

    const pass = await call({ action: "verdict", worker: "wv", verdict: "pass" });
    expect(pass.ok).toBe(true);
    expect(pass.model).toMatchObject({ passes: 1, maxDifficulty: 2 });
    const killed = await call({ action: "verdict", worker: "wk", verdict: "strike" });
    expect(killed.model).toMatchObject({ strikes: 1 });
    const stalled = await call({ action: "verdict", worker: "ws", verdict: "pass" });
    expect(stalled.ok).toBe(true);

    const lines = dispatchLines();
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.worker === "wv")).toMatchObject({
      model: MODEL,
      outcome: "done",
      verdict: "pass",
      costUsd: 0.5,
      tokens: { input: 10, output: 5 },
    });
    expect(lines.find((l) => l.worker === "wk")).toMatchObject({
      outcome: "killed",
      verdict: "strike",
    });
    expect(lines.find((l) => l.worker === "ws")).toMatchObject({ outcome: "stalled" });
    expect(loadState().workers.wv?.recordedAt).toBeDefined();

    // already recorded: verdict applies but no second dispatch line
    upsertWorker(rec("wr", MODEL, { state: "done", recordedAt: iso(5) }));
    const dup = await call({ action: "verdict", worker: "wr", verdict: "pass" });
    expect(dup.ok).toBe(true);
    expect(dispatchLines()).toHaveLength(3);
  });

  it("stamps an adopted orphan as recorded without adding a dispatch", async () => {
    importPolicy(tiersOnlyDoc([tierRow(MODEL, "fast", "strong", 2, "0 pass / 0 strike")]));
    upsertWorker(rec("wo", MODEL, { owner: "orphan", state: "done" }));
    const res = await call({ action: "verdict", worker: "wo", verdict: "pass", all: true });
    expect(res.ok).toBe(true);
    expect(existsSync(join(stateDir(), "dispatches.jsonl"))).toBe(false);
    expect(loadState().workers.wo?.recordedAt).toBeDefined();
  });

  it("errors for an unknown model, worker, missing or invalid verdict", async () => {
    expect(await call({ action: "verdict", worker: "ghost", verdict: "pass" })).toMatchObject({
      ok: false,
      error: "unknown worker: ghost",
    });
    upsertWorker(rec("wu", "nosuch/model"));
    const unknown = await call({ action: "verdict", worker: "wu", verdict: "pass" });
    expect(unknown.ok).toBe(false);
    expect(String(unknown.error)).toContain("unknown model: nosuch/model");
    expect(await call({ action: "verdict", worker: "wu" })).toEqual({
      ok: false,
      error: "verdict needs verdict",
    });
    expect(await call({ action: "verdict", worker: "wu", verdict: "maybe" })).toEqual({
      ok: false,
      error: "verdict needs verdict",
    });
  });
});

describe("logs", () => {
  it("reads the server log without a manager filter", async () => {
    await call({ action: "health" });
    await call({ action: "health" });
    const all = await call({ action: "logs" });
    expect((all.entries as LogEntry[]).length).toBeGreaterThan(0);
    const one = await call({ action: "logs", event: "tool.action", limit: 1 });
    expect(one.entries).toHaveLength(1);
    // manager is passed but never filtered on
    const filtered = await call({
      action: "logs",
      event: "tool.action",
      worker: "ghost",
      limit: 100,
    });
    expect((filtered.entries as LogEntry[]).every((e) => e.worker === "ghost")).toBe(true);
    expect((filtered.entries as LogEntry[]).every((e) => e.manager !== "maya")).toBe(true);
  });
});

describe("keep and release", () => {
  it("keeps a worker for a while", async () => {
    upsertWorker(rec("w1", MODEL));
    const res = await call({ action: "keep", worker: "w1", for_ms: 6000 });
    expect(res).toEqual({ ok: true });
    const record = loadState().workers.w1;
    expect(record?.keepUntil).toBeDefined();
    expect(Date.parse(record?.keepUntil ?? "")).toBeGreaterThan(Date.now());
    expect((await call({ action: "keep", worker: "ghost" })).ok).toBe(false);
  });

  it("releases a worker now and appends a reaped event", async () => {
    upsertWorker(rec("w2", MODEL));
    const res = await call({ action: "release", worker: "w2" });
    expect(res).toEqual({ ok: true });
    expect(loadState().workers.w2).toMatchObject({
      state: "killed",
      killReason: "released by owner",
    });
    expect(readEvents().some((e) => e.kind === "reaped" && e.worker === "w2")).toBe(true);
    expect((await call({ action: "release", worker: "ghost" })).ok).toBe(false);
  });
});

describe("ledger", () => {
  it("shows summarized models and defaults to show", async () => {
    importPolicy(tiersOnlyDoc([tierRow(MODEL, "fast", "strong", 2, "1 pass / 0 strike")]));
    const shown = await call({ action: "ledger", ledger_op: "show" });
    expect(shown.models).toEqual([
      expect.objectContaining({
        id: MODEL,
        pool: "other",
        maxDifficulty: 2,
        passes: 1,
        strikes: 0,
        benched: false,
        runs: 0,
        costUsd: 0,
      }),
    ]);
    expect((await call({ action: "ledger" })).models).toHaveLength(1);
  });

  it("imports the policy markdown and seeds pool ids", async () => {
    writeFileSync(
      process.env.OCM_POLICY_PATH ?? "",
      tiersWithPoolsDoc([tierRow(MODEL, "fast", "strong", 2, "0 pass / 0 strike")]),
    );
    const res = await call({ action: "ledger", ledger_op: "import" });
    expect(res).toEqual({ ok: true, imported: 1 });
    expect(loadLedger().models).toMatchObject({
      [MODEL]: { maxDifficulty: 2 },
      "opencode/sonoma-free": { maxDifficulty: 1 },
    });
  });

  it("falls back to ~/.claude/model-policy.md when OCM_POLICY_PATH is unset", async () => {
    process.env.HOME = base;
    delete process.env.OCM_POLICY_PATH;
    const res = await call({ action: "ledger", ledger_op: "import" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("ENOENT");
  });
});

describe("ledger export", () => {
  it("previews changed rows and only writes with confirm", async () => {
    const path = process.env.OCM_POLICY_PATH ?? "";
    writeFileSync(path, tiersOnlyDoc([tierRow(MODEL, "fast", "strong", 2, "1 pass / 0 strike")]));
    importPolicy(readFileSync(path, "utf8"));
    const preview = await call({ action: "ledger", ledger_op: "export" });
    expect(preview).toEqual({
      ok: true,
      written: false,
      changed_rows: 0,
      note: "pass confirm:true to write",
    });
    writeFileSync(path, tiersOnlyDoc([tierRow(MODEL, "fast", "strong", 1, "1 pass / 0 strike")]));
    const changed = await call({ action: "ledger", ledger_op: "export" });
    expect(changed).toEqual({
      ok: true,
      written: false,
      changed_rows: 1,
      note: "pass confirm:true to write",
    });
  });

  it("backs up the old file and rewrites with confirm", async () => {
    const path = process.env.OCM_POLICY_PATH ?? "";
    writeFileSync(path, tiersOnlyDoc([tierRow(MODEL, "fast", "strong", 1, "0 pass / 0 strike")]));
    importPolicy(readFileSync(path, "utf8"));
    writeFileSync(path, tiersOnlyDoc([tierRow(MODEL, "fast", "strong", 2, "0 pass / 0 strike")]));
    const first = await call({ action: "ledger", ledger_op: "export", confirm: true });
    expect(first.written).toBe(true);
    const backup = String(first.backup);
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("D1");
    expect(readFileSync(backup, "utf8")).toContain("D2");
    const second = await call({ action: "ledger", ledger_op: "export", confirm: true });
    expect(String(second.backup)).toContain("-2");
    expect(existsSync(String(second.backup))).toBe(true);
  });
});

describe("health", () => {
  it("reports version, counts, memory and paths", async () => {
    upsertWorker(rec("h1", MODEL, { state: "done" }));
    upsertWorker(rec("h2", MODEL));
    const res = await call({ action: "health" });
    expect(res).toMatchObject({
      ok: true,
      version: VERSION,
      workers: { done: 1, running: 1 },
      state_dir: stateDir(),
      log: serverLogPath(),
    });
    expect(res.memory).toMatchObject({ totalMb: 7812, availableMb: 7812 });
    expect(typeof res.uptime_s).toBe("number");
    process.env.OCM_MEMINFO = join(base, "gone");
    const again = await call({ action: "health" });
    expect(again.memory).toBeNull();
    // the production default path is /proc/meminfo on Linux
    delete process.env.OCM_MEMINFO;
    const fromProc = await call({ action: "health" });
    expect((fromProc.memory as { totalMb: number }).totalMb).toBeGreaterThan(0);
  });
});

describe("tick", () => {
  it("records a dispatch exactly once and skips non-terminal workers", {
    timeout: 15_000,
  }, async () => {
    const started = await call({
      action: "run",
      cwd: root,
      prompt: "work",
      ticket: "t9",
      model: MODEL,
    });
    const id = started.id as string;
    await until("worker done", () => loadState().workers[id]?.state === "done");
    upsertWorker(rec("idle-stalled", MODEL, { state: "stalled" }));
    await tick();
    let lines = dispatchLines();
    expect(lines).toHaveLength(1);
    const record = loadState().workers[id];
    expect(lines[0]).toMatchObject({
      worker: id,
      model: MODEL,
      ticket: "t9",
      difficulty: 2,
      outcome: "done",
      ts: record?.endedAt,
    });
    expect(record?.recordedAt).toBeDefined();
    expect(loadState().workers["idle-stalled"]?.recordedAt).toBeUndefined();
    await tick();
    lines = dispatchLines();
    expect(lines).toHaveLength(1);
  });

  it("records failed and limit-aware outcomes", { timeout: 15_000 }, async () => {
    process.env.FAKE_EXIT = "3";
    const failed = await call({ action: "run", cwd: root, prompt: "boom", model: MODEL });
    await until(
      "worker failed",
      () => loadState().workers[failed.id as string]?.state === "failed",
    );
    await tick();
    let lines = dispatchLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "failed", worker: failed.id });
    delete process.env.FAKE_EXIT;
    const good = await call({ action: "run", cwd: root, prompt: "fine", model: MODEL });
    const goodId = good.id as string;
    await until("worker done", () => loadState().workers[goodId]?.state === "done");
    appendEvent({ worker: goodId, owner: "maya", kind: "limit", detail: "five_hour until later" });
    await tick();
    lines = dispatchLines();
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.worker === goodId)).toMatchObject({ outcome: "limit" });
  });

  it("keeps ticking through shared-state failures", { timeout: 20_000 }, async () => {
    upsertWorker(rec("wz", MODEL, { state: "done", endedAt: iso(1) }));
    upsertWorker(rec("wr", MODEL));
    // a fresh lock blocks every updateState attempt: sweep and record steps fail alone
    writeFileSync(join(stateDir(), "state.json.lock"), "junk");
    await expect(tick()).resolves.toBeUndefined();
    expect(readLogs({ event: "tool.tick.sweep_failed" }).length).toBe(1);
    expect(readLogs({ event: "tool.tick.record_one_failed" }).length).toBe(1);
  });
});

describe("garbage input", () => {
  const raw = (input: unknown): Promise<ActionResult> =>
    handleAction(input as unknown as ActionInput);

  it("never throws and reports what is missing", async () => {
    expect(await raw(null)).toMatchObject({ ok: false, error: "action is required" });
    expect(await raw({})).toMatchObject({ ok: false, error: "action is required" });
    expect(await raw({ action: "wat" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("unknown action: wat"),
    });
    expect(await raw({ action: "health" })).toMatchObject({
      ok: false,
      error: "health needs manager",
    });
    expect(await raw({ action: "run", manager: "maya" })).toMatchObject({
      ok: false,
      error: "run needs cwd",
    });
  });

  it("turns unexpected action errors into ok:false", async () => {
    const res = await raw({ action: "keep", manager: "maya", worker: "ghost" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("unknown worker: ghost");
  });

  it("stringifies rejections that are not Error instances", async () => {
    const spy = vi.spyOn(reaper, "keepWorker").mockImplementation(() => {
      throw "nope";
    });
    const res = await raw({ action: "keep", manager: "maya", worker: "w-any" });
    expect(res).toMatchObject({ ok: false, error: "nope" });
    spy.mockRestore();
  });
});

describe("ownership of destructive actions", () => {
  it("refuses restart, keep and release on another manager's worker", async () => {
    upsertWorker(rec("o1", MODEL, { owner: "nora" }));
    for (const action of ["restart", "keep", "release"] as const) {
      const res = await call({ action, worker: "o1" });
      expect(res).toMatchObject({ ok: false, status: "refused_owner" });
      expect(String(res.error)).toContain("belongs to nora");
    }
    expect(loadState().workers.o1).toMatchObject({ state: "running" });
    expect(loadState().workers.o1?.keepUntil).toBeUndefined();
  });

  it("allows them with all:true, and keep/release on orphans without it", async () => {
    upsertWorker(rec("o2", MODEL, { owner: "nora" }));
    expect((await call({ action: "keep", worker: "o2", all: true })).ok).toBe(true);
    upsertWorker(rec("o3", MODEL, { owner: "orphan" }));
    expect((await call({ action: "keep", worker: "o3" })).ok).toBe(true);
    expect((await call({ action: "release", worker: "o3" })).ok).toBe(true);
    expect(loadState().workers.o3?.state).toBe("killed");
  });
});

describe("restart with nothing to switch to", () => {
  it("leaves a live worker running instead of killing it", async () => {
    process.env.OCM_OPENCODE_BIN = bin("slow2", SLOW);
    const live = await launchWorker({ owner: "maya", cwd: root, model: MODEL, prompt: "do t9" });
    await until("worker running", () => loadState().workers[live.id]?.state === "running");
    const res = await call({ action: "restart", worker: live.id });
    expect(res).toEqual({ ok: false, error: "no replacement model available" });
    expect(() => process.kill(live.pid, 0)).not.toThrow();
    expect(loadState().workers[live.id]?.state).toBe("running");
    process.kill(live.pid, "SIGKILL");
  });
});

describe("running counts", () => {
  it("count several running workers on one model when ranking picks", async () => {
    importPolicy(tiersOnlyDoc([tierRow(MODEL, "fast", "strong", 3, "1 pass / 0 strike")]));
    upsertWorker(rec("c1", MODEL));
    upsertWorker(rec("c2", MODEL));
    const res = await call({ action: "pick", difficulty: 2 });
    expect(res.ok).toBe(true);
    expect((res.picks as { id: string }[]).map((p) => p.id)).toEqual([MODEL]);
  });
});

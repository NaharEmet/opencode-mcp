import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLogs } from "../../../src/modules/ocm/log.js";
import {
  adoptOrphans,
  defaultDeps,
  keepWorker,
  type ReaperDeps,
  reapStep,
  releaseWorker,
} from "../../../src/modules/ocm/reaper.js";
import { loadState, upsertWorker, type WorkerRecord } from "../../../src/modules/ocm/state.js";

const NODE_DIR = dirname(process.execPath);
const NOW = new Date("2026-01-07T12:00:00.000Z");
const T0 = NOW.getTime();
const AGE = 72 * 60_000; // 1h12m, past the default 1h ask threshold

type EmitEvent = {
  worker: string;
  owner: string;
  kind: "reap_ask" | "reaped" | "orphan";
  detail: string;
};

interface Fake {
  deps: ReaperDeps;
  emits: EmitEvent[];
  killed: number[];
  calls: string[];
}

let base: string;
let binsDir: string;
let savedPath: string | undefined;
const children: ChildProcess[] = [];

function fakeDeps(over: Partial<ReaperDeps> = {}): Fake {
  const emits: EmitEvent[] = [];
  const killed: number[] = [];
  const calls: string[] = [];
  const deps: ReaperDeps = {
    emit: (e) => {
      calls.push("emit");
      emits.push(e);
    },
    isAlive: () => true,
    kill: (pid) => {
      calls.push("kill");
      killed.push(pid);
      return Promise.resolve();
    },
    hasUncommitted: () => {
      calls.push("uncommitted");
      return false;
    },
    listProcesses: () => [],
    ...over,
  };
  return { deps, emits, killed, calls };
}

function fixture(id: string, over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id,
    pid: 4242,
    owner: "owen",
    ticket: "t-1",
    model: "m/g",
    cwd: "/work",
    startedAt: new Date(T0 - AGE).toISOString(),
    state: "running",
    ...over,
  };
}

// ps stub: the module talks to real ps, so fake the binary on PATH instead
function fakePs(): void {
  const script = [
    "#!/usr/bin/env node",
    'const mode = process.env.FAKE_PS_MODE ?? "";',
    "const args = process.argv.slice(2);",
    'if (args[1] === "ppid=") {',
    '  if (mode === "ppid_fail") process.exit(1);',
    '  process.stdout.write((process.env.FAKE_PPID ?? "") + "\\n");',
    "  process.exit(0);",
    "}",
    'if (mode === "fail") process.exit(1);',
    'if (mode === "listing") {',
    "  const lines = [",
    '    process.env.FAKE_PID + " 120 opencode run -m m/g do ticket",',
    '    "999999 60 opencode run",',
    '    "888888 30 sh -c echo hi",',
    "  ];",
    '  process.stdout.write(lines.join("\\n") + "\\n");',
    "}",
  ].join("\n");
  const path = join(binsDir, "ps");
  writeFileSync(path, `${script}\n`);
  chmodSync(path, 0o755);
}

function fakePath(): void {
  process.env.PATH = `${binsDir}:${NODE_DIR}`;
}

function spawnDetached(script: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  child.unref();
  children.push(child);
  return child;
}

function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit")), 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function until(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ocm-reaper-"));
  binsDir = join(base, "bins");
  mkdirSync(binsDir);
  process.env.OCM_STATE_DIR = join(base, "state");
  for (const [name, value] of [
    ["OCM_REAP_AFTER_MS", "3600000"],
    ["OCM_REAP_GRACE_MS", "900000"],
    ["OCM_REAP_IDLE_MS", "900000"],
  ] as const) {
    process.env[name] = value;
  }
  savedPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = savedPath;
  for (const name of [
    "OCM_STATE_DIR",
    "OCM_REAP_AFTER_MS",
    "OCM_REAP_GRACE_MS",
    "OCM_REAP_IDLE_MS",
    "OCM_REAP_ORPHANS",
    "FAKE_PS_MODE",
    "FAKE_PPID",
    "FAKE_PID",
  ] as const) {
    delete process.env[name];
  }
  for (const child of children) {
    const pid = child.pid as number;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  children.length = 0;
  rmSync(base, { recursive: true, force: true });
});

describe("reapStep", () => {
  it("skips workers that are too young and ignores terminal states", async () => {
    upsertWorker(fixture("young", { startedAt: new Date(T0 - 10 * 60_000).toISOString() }));
    upsertWorker(fixture("done", { state: "done" }));
    const { deps, emits, killed } = fakeDeps();
    await reapStep(deps, NOW);
    expect(killed).toEqual([]);
    expect(emits).toEqual([]);
    expect(loadState().workers.young?.askedAt).toBeUndefined();
    expect(loadState().workers.done?.state).toBe("done");
  });

  it("skips a worker kept into the future", async () => {
    upsertWorker(fixture("w1", { keepUntil: new Date(T0 + 60_000).toISOString() }));
    const { deps, emits, killed } = fakeDeps();
    await reapStep(deps, NOW);
    expect(killed).toEqual([]);
    expect(emits).toEqual([]);
  });

  it("asks on the first pass and records askedAt", async () => {
    upsertWorker(fixture("w1"));
    upsertWorker(
      fixture("w2", {
        pid: 777,
        ticket: undefined,
        keepUntil: new Date(T0 - 60_000).toISOString(), // expired keep still reaps
      }),
    );
    const { deps, emits } = fakeDeps();
    await reapStep(deps, NOW);
    expect(emits).toEqual([
      {
        worker: "w1",
        owner: "owen",
        kind: "reap_ask",
        detail: `worker w1 (m/g, ticket t-1) is 1h12m old; still using it? keep w1 or release w1`,
      },
      {
        worker: "w2",
        owner: "owen",
        kind: "reap_ask",
        detail: expect.stringContaining("ticket none"),
      },
    ]);
    expect(loadState().workers.w1?.askedAt).toBe(NOW.toISOString());
    expect(loadState().workers.w1?.state).toBe("running");
  });

  it("stays silent within the grace window", async () => {
    upsertWorker(
      fixture("w1", {
        askedAt: new Date(T0 - 5 * 60_000).toISOString(),
        lastActivityAt: new Date(T0 - AGE).toISOString(),
      }),
    );
    const { deps, emits, killed } = fakeDeps();
    await reapStep(deps, NOW);
    expect(killed).toEqual([]);
    expect(emits).toEqual([]);
    expect(loadState().workers.w1?.askedAt).toBe(new Date(T0 - 5 * 60_000).toISOString());
  });

  it("kills after grace when idle, checking uncommitted before the kill", async () => {
    upsertWorker(
      fixture("w1", {
        askedAt: new Date(T0 - 20 * 60_000).toISOString(),
        lastActivityAt: new Date(T0 - AGE).toISOString(),
      }),
    );
    const { deps, emits, killed, calls } = fakeDeps();
    await reapStep(deps, NOW);
    expect(calls.slice(0, 2)).toEqual(["uncommitted", "kill"]);
    expect(killed).toEqual([4242]);
    const rec = loadState().workers.w1;
    expect(rec?.state).toBe("killed");
    expect(rec?.endedAt).toBe(NOW.toISOString());
    expect(rec?.killReason).toBe("reaped after 1h12m idle 1h12m");
    expect(emits[0]?.kind).toBe("reaped");
    expect(emits[0]?.detail).toBe(
      "worker w1 killed in /work; uncommitted changes: no (reaped after 1h12m idle 1h12m)",
    );
  });

  it("reports uncommitted changes as yes in the reaped event", async () => {
    upsertWorker(
      fixture("w1", {
        askedAt: new Date(T0 - 20 * 60_000).toISOString(),
        lastActivityAt: new Date(T0 - AGE).toISOString(),
      }),
    );
    const { deps, emits } = fakeDeps({ hasUncommitted: () => true });
    await reapStep(deps, NOW);
    expect(emits[0]?.detail).toBe(
      "worker w1 killed in /work; uncommitted changes: yes (reaped after 1h12m idle 1h12m)",
    );
  });

  it("re-asks an active worker past grace and moves askedAt forward", async () => {
    upsertWorker(
      fixture("w1", {
        askedAt: new Date(T0 - 20 * 60_000).toISOString(),
        lastActivityAt: new Date(T0 - 60_000).toISOString(),
      }),
    );
    const { deps, emits, killed } = fakeDeps();
    await reapStep(deps, NOW);
    expect(killed).toEqual([]);
    expect(emits).toHaveLength(1);
    expect(emits[0]?.kind).toBe("reap_ask");
    expect(emits[0]?.detail).toContain("is 1h12m old");
    expect(loadState().workers.w1?.askedAt).toBe(NOW.toISOString());
    expect(loadState().workers.w1?.state).toBe("running");
  });

  it("leaves an orphan alone by default: it may belong to another live session", async () => {
    upsertWorker(
      fixture("w1", {
        state: "orphan",
        askedAt: new Date(T0 - 20 * 60_000).toISOString(),
      }),
    );
    const { deps, emits, killed } = fakeDeps();
    await reapStep(deps, NOW);
    expect(killed).toEqual([]);
    expect(emits).toEqual([]);
    expect(loadState().workers.w1?.state).toBe("orphan");
  });

  it("kills an orphan past grace even with fresh activity when OCM_REAP_ORPHANS=kill", async () => {
    process.env.OCM_REAP_ORPHANS = "kill";
    upsertWorker(
      fixture("w1", {
        state: "orphan",
        askedAt: new Date(T0 - 20 * 60_000).toISOString(),
        lastActivityAt: new Date(T0 - 60_000).toISOString(),
      }),
    );
    const { deps, emits, killed } = fakeDeps();
    await reapStep(deps, NOW);
    expect(killed).toEqual([4242]);
    expect(loadState().workers.w1?.killReason).toBe("reaped after 1h12m idle 1m");
    expect(emits[0]?.kind).toBe("reaped");
  });

  it("marks a dead pid done, not killed, without an ask", async () => {
    upsertWorker(fixture("w1"));
    const { deps, emits, killed } = fakeDeps({ isAlive: () => false });
    await reapStep(deps, NOW);
    expect(killed).toEqual([]);
    expect(emits).toEqual([
      { worker: "w1", owner: "owen", kind: "reaped", detail: "worker w1 already exited" },
    ]);
    const rec = loadState().workers.w1;
    expect(rec?.state).toBe("done");
    expect(rec).not.toHaveProperty("killReason");
    expect(rec?.endedAt).toBe(NOW.toISOString());
  });

  it("keeps going when one worker's ask fails", async () => {
    upsertWorker(fixture("a"));
    upsertWorker(fixture("b", { pid: 999 }));
    let n = 0;
    const { deps, killed } = fakeDeps({
      emit: () => {
        n += 1;
        if (n === 1) throw new Error("boom");
      },
    });
    await reapStep(deps, NOW);
    expect(loadState().workers.b?.askedAt).toBe(NOW.toISOString());
    expect(killed).toEqual([]);
    expect(readLogs({ event: "reaper.step_failed", level: "error" }).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("honors env overrides and falls back on garbage or negative values", async () => {
    process.env.OCM_REAP_AFTER_MS = "0";
    upsertWorker(fixture("young", { startedAt: new Date(T0 - 10 * 60_000).toISOString() }));
    const first = fakeDeps();
    await reapStep(first.deps, NOW);
    expect(first.emits).toHaveLength(1); // 0ms threshold asks immediately

    process.env.OCM_REAP_AFTER_MS = "abc";
    upsertWorker(
      fixture("young2", { pid: 999, startedAt: new Date(T0 - 10 * 60_000).toISOString() }),
    );
    const second = fakeDeps();
    await reapStep(second.deps, NOW);
    expect(second.emits).toEqual([]); // garbage falls back to 1h, so too young
    expect(loadState().workers.young2?.askedAt).toBeUndefined();

    process.env.OCM_REAP_GRACE_MS = "-1";
    upsertWorker(
      fixture("w", {
        pid: 555,
        askedAt: new Date(T0 - 10 * 60_000).toISOString(),
        lastActivityAt: new Date(T0 - AGE).toISOString(),
      }),
    );
    const third = fakeDeps();
    await reapStep(third.deps, NOW);
    expect(third.killed).toEqual([]); // negative falls back to 15min grace
    expect(third.emits).toEqual([]);
  });

  it("defaults now to the current time", async () => {
    const t = Date.now();
    upsertWorker({
      id: "rt",
      pid: 4242,
      owner: "owen",
      model: "m/g",
      cwd: "/work",
      startedAt: new Date(t - 90 * 60_000).toISOString(),
      lastActivityAt: new Date(t - 90 * 60_000).toISOString(),
      state: "running",
    });
    const { deps, killed } = fakeDeps();
    await reapStep(deps);
    expect(killed).toEqual([]); // first pass asks, never kills
    const rec = loadState().workers.rt;
    expect(rec?.askedAt).toBeDefined();
    expect(Math.abs(Date.parse(rec?.askedAt as string) - Date.now())).toBeLessThan(10_000);
  });
});

describe("keepWorker", () => {
  it("sets keepUntil, clears askedAt, and protects the worker", async () => {
    upsertWorker(fixture("w1", { askedAt: new Date(T0 - 20 * 60_000).toISOString() }));
    keepWorker("w1", 60_000, NOW);
    const rec = loadState().workers.w1;
    expect(rec?.keepUntil).toBe(new Date(T0 + 60_000).toISOString());
    expect(rec?.askedAt).toBeUndefined();
    const { deps, emits, killed } = fakeDeps();
    await reapStep(deps, NOW);
    expect(killed).toEqual([]);
    expect(emits).toEqual([]);
  });

  it("throws for an unknown id", () => {
    expect(() => keepWorker("nope", 1000, NOW)).toThrow("unknown worker: nope");
  });

  it("defaults to one hour and real time", () => {
    upsertWorker(fixture("w1"));
    keepWorker("w1");
    const keepUntil = Date.parse(loadState().workers.w1?.keepUntil as string);
    expect(keepUntil - Date.now()).toBeGreaterThan(3_500_000);
    expect(keepUntil - Date.now()).toBeLessThanOrEqual(3_605_000);
  });
});

describe("releaseWorker", () => {
  it("releases immediately with the released reason", async () => {
    upsertWorker(fixture("w1", { askedAt: new Date(T0 - 60_000).toISOString() }));
    const { deps, emits, killed, calls } = fakeDeps();
    await releaseWorker("w1", deps, NOW);
    expect(calls.slice(0, 2)).toEqual(["uncommitted", "kill"]);
    expect(killed).toEqual([4242]);
    const rec = loadState().workers.w1;
    expect(rec?.state).toBe("killed");
    expect(rec?.endedAt).toBe(NOW.toISOString());
    expect(rec?.killReason).toBe("released by owner");
    expect(emits[0]?.kind).toBe("reaped");
    expect(emits[0]?.detail).toBe(
      "worker w1 killed in /work; uncommitted changes: no (released by owner)",
    );
  });

  it("throws for an unknown id", async () => {
    await expect(releaseWorker("nope", fakeDeps().deps, NOW)).rejects.toThrow(
      "unknown worker: nope",
    );
  });

  it("uses real time when now is omitted", async () => {
    upsertWorker(fixture("w1"));
    await releaseWorker("w1", fakeDeps().deps);
    expect(loadState().workers.w1?.state).toBe("killed");
  });
});

describe("adoptOrphans", () => {
  it("adopts only literal `opencode run` processes", () => {
    upsertWorker(fixture("tracked", { pid: 4242 }));
    const { deps, emits } = fakeDeps({
      listProcesses: () => [
        { pid: 111, ageSec: 60, cmdline: "opencode serve" },
        { pid: 112, ageSec: 60, cmdline: "npm exec opencode run -m m/g" },
        { pid: 113, ageSec: 60, cmdline: "sh -c opencode run -m m/g" },
        { pid: process.pid, ageSec: 60, cmdline: "opencode run -m m/g" },
        { pid: 4242, ageSec: 60, cmdline: "opencode run -m m/g" },
        {
          pid: 555,
          ageSec: 120,
          cwd: "/elsewhere",
          model: "m/g",
          cmdline: "opencode run -m m/g hi",
        },
        { pid: 556, ageSec: 30, cmdline: "opencode run" },
      ],
    });
    adoptOrphans(deps, NOW);
    const workers = loadState().workers;
    expect(Object.keys(workers).sort()).toEqual(["orphan-555", "orphan-556", "tracked"]);
    expect(workers["orphan-555"]).toMatchObject({
      id: "orphan-555",
      pid: 555,
      owner: "orphan",
      model: "m/g",
      cwd: "/elsewhere",
      startedAt: new Date(T0 - 120_000).toISOString(),
      state: "orphan",
    });
    expect(workers["orphan-556"]).toMatchObject({ model: "unknown", cwd: "unknown" });
    expect(emits).toHaveLength(2);
    expect(emits[0]).toMatchObject({ worker: "orphan-555", owner: "orphan", kind: "orphan" });
    expect(emits[0]?.detail).toContain("orphan-555");
  });

  it("does not adopt the same pid twice", () => {
    const { deps, emits } = fakeDeps({
      listProcesses: () => [
        { pid: 555, ageSec: 60, cwd: "/w", model: "m/g", cmdline: "opencode run" },
      ],
    });
    adoptOrphans(deps, NOW);
    adoptOrphans(deps, NOW);
    expect(emits).toHaveLength(1);
    expect(Object.keys(loadState().workers)).toEqual(["orphan-555"]);
  });

  it("adopts nothing when there are no candidate processes", () => {
    const { deps, emits } = fakeDeps();
    adoptOrphans(deps, NOW);
    expect(emits).toEqual([]);
    expect(loadState().workers).toEqual({});
  });

  it("skips its own ancestors", () => {
    fakePs();
    fakePath();
    process.env.FAKE_PS_MODE = "ppid";
    process.env.FAKE_PPID = "777777";
    const { deps } = fakeDeps({
      listProcesses: () => [{ pid: 777777, ageSec: 60, cmdline: "opencode run -m m/g" }],
    });
    adoptOrphans(deps, NOW);
    expect(loadState().workers).toEqual({});
  });

  it("treats an unreadable ancestor chain as unrelated", () => {
    fakePs();
    fakePath();
    process.env.FAKE_PS_MODE = "ppid_fail";
    const { deps, emits } = fakeDeps({
      listProcesses: () => [{ pid: 777777, ageSec: 60, cmdline: "opencode run -m m/g" }],
    });
    adoptOrphans(deps, NOW);
    expect(Object.keys(loadState().workers)).toEqual(["orphan-777777"]);
    expect(emits).toHaveLength(1);
  });

  it("defaults now to the current time", () => {
    const t = Date.now();
    const { deps } = fakeDeps({
      listProcesses: () => [{ pid: 555, ageSec: 120, cmdline: "opencode run -m m/g" }],
    });
    adoptOrphans(deps);
    const started = Date.parse(loadState().workers["orphan-555"]?.startedAt as string);
    expect(t - started).toBeGreaterThanOrEqual(120_000);
    expect(t - started).toBeLessThan(130_000);
  });
});

describe("defaultDeps", () => {
  it("isAlive and kill a real detached child via the process group", async () => {
    const deps = defaultDeps(() => {});
    const child = spawnDetached("setTimeout(() => {}, 60000)");
    const pid = child.pid as number;
    expect(deps.isAlive(pid)).toBe(true);
    await deps.kill(pid);
    expect(deps.isAlive(pid)).toBe(false);
  });

  it("falls back to the pid when there is no process group", { timeout: 10_000 }, async () => {
    const deps = defaultDeps(() => {});
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    children.push(child);
    const exited = exitOf(child);
    await deps.kill(child.pid as number);
    await exited;
    expect(deps.isAlive(child.pid as number)).toBe(false);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", { timeout: 20_000 }, async () => {
    const deps = defaultDeps(() => {});
    // the child signals readiness after installing its handler: a SIGTERM sent
    // too early would hit the default disposition and defeat the test
    const ready = join(base, "sigterm-ready");
    const child = spawnDetached(
      `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ok");` +
        "process.on('SIGTERM', () => {});setInterval(() => {}, 1000);",
    );
    const pid = child.pid as number;
    await until("child ready", () => existsSync(ready));
    await deps.kill(pid);
    await until("child died", () => !deps.isAlive(pid));
  });

  it("resolves when the pid is already gone", async () => {
    const deps = defaultDeps(() => {});
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    children.push(child);
    await exitOf(child);
    const pid = child.pid as number;
    await deps.kill(pid);
    expect(deps.isAlive(pid)).toBe(false);
  });

  it("reports uncommitted changes via git and stays false outside a repo", () => {
    const deps = defaultDeps(() => {});
    const repo = join(base, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    expect(deps.hasUncommitted(repo)).toBe(false);
    writeFileSync(join(repo, "f.txt"), "x");
    expect(deps.hasUncommitted(repo)).toBe(true);
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(deps.hasUncommitted(plain)).toBe(false);
    expect(
      readLogs({ event: "reaper.uncommitted_check_failed", level: "warn" }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("lists processes including this one", () => {
    const deps = defaultDeps(() => {});
    const procs = deps.listProcesses();
    const me = procs.find((p) => p.pid === process.pid);
    expect(me?.cwd).toBe(process.cwd());
    expect(me?.ageSec).toBeGreaterThanOrEqual(0);
    expect((me?.cmdline ?? "").length).toBeGreaterThan(0);
    expect(deps.isAlive(process.pid)).toBe(true);
  });

  it("parses model and etimes and tolerates an unreadable cwd", () => {
    fakePs();
    fakePath();
    process.env.FAKE_PS_MODE = "listing";
    process.env.FAKE_PID = String(process.pid);
    const procs = defaultDeps(() => {}).listProcesses();
    expect(procs.find((p) => p.pid === process.pid)).toEqual({
      pid: process.pid,
      ageSec: 120,
      cwd: process.cwd(),
      model: "m/g",
      cmdline: "opencode run -m m/g do ticket",
    });
    expect(procs.find((p) => p.pid === 999999)).toEqual({
      pid: 999999,
      ageSec: 60,
      cwd: undefined,
      model: undefined,
      cmdline: "opencode run",
    });
    expect(procs.find((p) => p.pid === 888888)).toEqual({
      pid: 888888,
      ageSec: 30,
      cwd: undefined,
      model: undefined,
      cmdline: "sh -c echo hi",
    });
  });

  it("returns [] and logs when ps fails", () => {
    fakePs();
    fakePath();
    process.env.FAKE_PS_MODE = "fail";
    expect(defaultDeps(() => {}).listProcesses()).toEqual([]);
    expect(readLogs({ event: "reaper.ps_failed", level: "error" }).length).toBeGreaterThanOrEqual(
      1,
    );
  });
});

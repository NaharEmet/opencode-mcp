import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLogs } from "../../../src/modules/ocm/log.js";
import {
  loadState,
  markCleared,
  recordWarning,
  type State,
  saveState,
  takeWarning,
  updateState,
  upsertWorker,
  type WorkerRecord,
} from "../../../src/modules/ocm/state.js";

let dir: string;

const T0 = new Date("2026-01-01T00:00:00.000Z");

function worker(id: string, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id,
    pid: 123,
    owner: "own",
    model: "m",
    cwd: "/w",
    startedAt: T0.toISOString(),
    state: "running",
    ...overrides,
  };
}

function statePath(): string {
  return join(dir, "state.json");
}

function lockPath(): string {
  return `${statePath()}.lock`;
}

function fullState(): State {
  return {
    version: 1,
    workers: {
      w1: worker("w1", {
        ticket: "T1",
        session: "ses_1",
        lastActivityAt: T0.toISOString(),
        state: "done",
        endedAt: T0.toISOString(),
        exitCode: 0,
        killReason: "ok",
        keepUntil: T0.toISOString(),
      }),
    },
    warnings: [{ owner: "own", model: "m", at: T0.toISOString() }],
    cleared: { m: T0.toISOString() },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocm-state-"));
  process.env.OCM_STATE_DIR = dir;
});

afterEach(() => {
  delete process.env.OCM_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("load/save round trip", () => {
  it("returns an empty state when nothing is on disk", () => {
    expect(loadState()).toEqual({ version: 1, workers: {}, warnings: [], cleared: {} });
  });

  it("persists and reloads every field", () => {
    const state = fullState();
    saveState(state);
    expect(loadState()).toEqual(state);
  });

  it("keeps the previous version in state.json.bak and leaves no temp files", () => {
    const first = fullState();
    saveState(first);
    const second = { ...first, workers: {} };
    saveState(second);
    expect(loadState()).toEqual(second);
    expect(JSON.parse(readFileSync(`${statePath()}.bak`, "utf8"))).toEqual(first);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("creates the state directory when it is missing", () => {
    dir = join(dir, "nested", "state");
    process.env.OCM_STATE_DIR = dir;
    saveState(fullState());
    expect(loadState().workers.w1?.id).toBe("w1");
  });
});

describe("corruption recovery", () => {
  it("falls back to state.json.bak when the primary is corrupt", () => {
    writeFileSync(statePath(), "not json at all");
    writeFileSync(`${statePath()}.bak`, JSON.stringify(fullState()));
    expect(loadState()).toEqual(fullState());
    const [entry] = readLogs({ level: "error", event: "state.corrupt" });
    expect(entry.path).toBe(statePath());
    expect(entry.bytes).toBe("not json at all".length);
  });

  it("returns an empty state when the primary is corrupt and no backup exists", () => {
    writeFileSync(statePath(), "not json at all");
    expect(loadState()).toEqual({ version: 1, workers: {}, warnings: [], cleared: {} });
    expect(readLogs({ level: "error", event: "state.corrupt" }).length).toBe(1);
  });

  it("returns an empty state when both primary and backup are corrupt", () => {
    writeFileSync(statePath(), "not json at all");
    writeFileSync(`${statePath()}.bak`, "also not json");
    expect(loadState()).toEqual({ version: 1, workers: {}, warnings: [], cleared: {} });
    const paths = readLogs({ level: "error", event: "state.corrupt" }).map((e) => e.path);
    expect(paths).toEqual([statePath(), `${statePath()}.bak`]);
  });

  it.each([
    ["wrong version", '{"version":2}'],
    ["null payload", "null"],
    ["number payload", "5"],
  ])("treats %s as corrupt", (_name, raw) => {
    writeFileSync(statePath(), raw);
    expect(loadState()).toEqual({ version: 1, workers: {}, warnings: [], cleared: {} });
  });
});

describe("locking", () => {
  it("returns the fn result and persists its mutations", () => {
    const id = updateState((state) => {
      state.workers.w1 = worker("w1");
      return state.workers.w1.id;
    });
    expect(id).toBe("w1");
    expect(loadState().workers.w1?.id).toBe("w1");
  });

  it("releases the lock when fn throws", () => {
    expect(() =>
      updateState(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath())).toBe(false);
    expect(updateState(() => 42)).toBe(42);
  });

  it("removes a stale lock", () => {
    writeFileSync(lockPath(), "999");
    const old = new Date(Date.now() - 20000);
    utimesSync(lockPath(), old, old);
    expect(updateState((state) => state.version)).toBe(1);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("treats an unstattable lock as stale", () => {
    symlinkSync(join(dir, "gone"), lockPath());
    expect(updateState((state) => state.version)).toBe(1);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("throws after ~2s when a fresh lock never frees", () => {
    writeFileSync(lockPath(), "999");
    expect(() => updateState((state) => state.version)).toThrow("state lock busy");
    expect(existsSync(lockPath())).toBe(true);
  }, 10000);

  it("throws immediately on lock creation errors that are not contention", () => {
    // Assumes a non-root user: root bypasses directory permissions.
    const ro = join(dir, "read-only");
    mkdirSync(ro, 0o555);
    process.env.OCM_STATE_DIR = ro;
    try {
      expect(() => updateState((state) => state.version)).toThrow(/permission denied/i);
    } finally {
      process.env.OCM_STATE_DIR = dir;
      chmodSync(ro, 0o755);
    }
  });
});

describe("warnings", () => {
  it("takes a matching warning once within the window", () => {
    recordWarning("own", "m", T0);
    expect(takeWarning("own", "m", 5000, new Date(T0.getTime() + 1000))).toBe(true);
    expect(takeWarning("own", "m", 5000, new Date(T0.getTime() + 1000))).toBe(false);
    expect(loadState().warnings).toEqual([]);
  });

  it("misses on different owner or model", () => {
    recordWarning("own", "m", T0);
    expect(takeWarning("other", "m", 5000, T0)).toBe(false);
    expect(takeWarning("own", "other", 5000, T0)).toBe(false);
    expect(loadState().warnings.length).toBe(1);
  });

  it("misses and prunes expired warnings", () => {
    recordWarning("own", "m", T0);
    expect(takeWarning("own", "m", 1000, new Date(T0.getTime() + 10000))).toBe(false);
    expect(loadState().warnings).toEqual([]);
  });

  it("keeps fresh warnings from other owners while consuming the hit", () => {
    recordWarning("own", "m", T0);
    const t1 = new Date(T0.getTime() + 30000);
    recordWarning("own", "m", t1);
    recordWarning("other", "m", t1);
    expect(takeWarning("own", "m", 1000, new Date(t1.getTime() + 500))).toBe(true);
    expect(loadState().warnings).toEqual([{ owner: "other", model: "m", at: t1.toISOString() }]);
  });

  it("defaults to the current time", () => {
    recordWarning("own", "m");
    expect(takeWarning("own", "m", 60000)).toBe(true);
  });
});

describe("markCleared", () => {
  it("records and overwrites the clear time per model key", () => {
    const t1 = new Date(T0.getTime() + 1000);
    markCleared("m/x", T0);
    expect(loadState().cleared["m/x"]).toBe(T0.toISOString());
    markCleared("m/x", t1);
    expect(loadState().cleared["m/x"]).toBe(t1.toISOString());
    markCleared("m/y");
    expect(loadState().cleared["m/y"]).toBeTypeOf("string");
  });
});

describe("upsertWorker", () => {
  it("inserts and replaces worker records", () => {
    upsertWorker(worker("w1"));
    upsertWorker(worker("w2"));
    upsertWorker(worker("w1", { state: "done" }));
    const { workers } = loadState();
    expect(Object.keys(workers)).toEqual(["w1", "w2"]);
    expect(workers.w1?.state).toBe("done");
  });
});

describe("concurrency", () => {
  it("keeps every update across concurrent updateState calls", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        updateState((state) => {
          state.workers[`w${n}`] = worker(`w${n}`, { pid: n });
          return n;
        }),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const workers = loadState().workers;
    expect(Object.keys(workers).sort()).toEqual(Array.from({ length: 10 }, (_, n) => `w${n}`));
    expect(existsSync(lockPath())).toBe(false);
  });

  it("keeps updates from the helper wrappers run concurrently", async () => {
    await Promise.all([
      upsertWorker(worker("w1")),
      recordWarning("own", "m", T0),
      markCleared("m/x", T0),
      upsertWorker(worker("w2")),
      recordWarning("own", "m2", T0),
    ]);
    const state = loadState();
    expect(Object.keys(state.workers)).toEqual(["w1", "w2"]);
    expect(state.warnings.length).toBe(2);
    expect(state.cleared["m/x"]).toBe(T0.toISOString());
  });
});

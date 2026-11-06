import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { workersDir } from "../../../src/modules/ocm/evidence.js";
import { readLogs } from "../../../src/modules/ocm/log.js";
import {
  appendEvent,
  ingestWorker,
  psRows,
  readEvents,
  sweep,
  waitForEvents,
  workerResult,
} from "../../../src/modules/ocm/monitor.js";
import {
  loadState,
  type State,
  updateState,
  upsertWorker,
  type WorkerRecord,
} from "../../../src/modules/ocm/state.js";

// Wrap state's updateState so tests can inject a competing writer that mutates
// the record the moment monitor touches it; everything else stays passthrough.
vi.mock("../../../src/modules/ocm/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/ocm/state.js")>();
  type Hook = (state: State) => void;
  const conflicts: Hook[] = [];
  const updateState = Object.assign(
    vi.fn(
      <T>(fn: (state: State) => T): T =>
        actual.updateState((state) => {
          for (const conflict of conflicts) conflict(state);
          return fn(state);
        }),
    ),
    { conflicts },
  );
  return { ...actual, updateState };
});

const NOW = new Date("2026-11-07T12:00:00.000Z");
const MODEL = "zai-coding-plan/glm-5.3-flash";
const RESET_AT = new Date(1793989303016 + 20313000).toISOString();
const FREE_LIMIT_DETAIL = `free_usage until ${RESET_AT}`;

const STEP_START_EVENT =
  '{"type":"step_start","timestamp":1793989301108,"sessionID":"ses_first_session","part":{}}';
const TEXT_FIRST_EVENT =
  '{"type":"text","timestamp":1793989302189,"sessionID":"ses_first_session","part":{"type":"text","text":"I\'ll start by reading the file."}}';
const TEXT_LAST_EVENT =
  '{"type":"text","timestamp":1793989302500,"sessionID":"ses_first_session","part":{"type":"text","text":"Done."}}';
const TEXT_NO_PART_EVENT = '{"type":"text","timestamp":1793989302400,"sessionID":"ses_first"}';
const FREE_LIMIT_ERROR =
  '{"type":"error","timestamp":1793989303016,"sessionID":"ses_first_session",' +
  '"error":{"type":"provider.free-limit","message":"Free usage limit reached.","status":429,' +
  '"retryAfterMs":20313000}}';
const SECOND_FREE_LIMIT_ERROR =
  '{"type":"error","timestamp":1793989303090,"sessionID":"ses_first_session",' +
  '"error":{"type":"provider.free-limit","message":"Free usage limit reached.","status":429,' +
  '"retryAfterMs":20313000}}';
const MODEL_DISABLED_ERROR =
  '{"type":"error","timestamp":1793989303200,"sessionID":"ses_first_session",' +
  '"error":{"type":"provider.auth","message":"Model access is disabled","status":403}}';
const UNRECOGNIZED_ERROR =
  '{"type":"error","timestamp":1793989303300,"sessionID":"ses_first_session",' +
  '"error":{"type":"weird","message":"unrecognized problem"}}';
const FINISH_STOP_EVENT =
  '{"type":"step_finish","timestamp":1793989304000,"sessionID":"ses_first_session","part":{"reason":"stop"}}';
// no sessionID and no timestamp: ingest derives nothing from it
const BARE_STEP_EVENT = '{"type":"step_start","part":{}}';
// a sessionID without a timestamp, and a timestamp without a sessionID
const SESSION_NO_TS_EVENT = '{"type":"step_start","sessionID":"ses_first_session"}';
const NO_SESSION_STEP_EVENT = '{"type":"step_start","timestamp":1793989301050}';

function worker(id: string, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id,
    pid: process.pid,
    owner: "o1",
    ticket: "T1",
    model: MODEL,
    cwd: process.cwd(),
    startedAt: NOW.toISOString(),
    state: "running",
    ...overrides,
  };
}

function outPath(id: string): string {
  return join(workersDir(), `${id}.out.jsonl`);
}

function errPath(id: string): string {
  return join(workersDir(), `${id}.err.log`);
}

function writeOut(id: string, lines: string[], trailingNewline = true): void {
  const body = lines.length === 0 ? "" : `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
  writeFileSync(outPath(id), body);
}

/** A pid that is certainly dead: spawn a short-lived child and wait for exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid as number;
  return new Promise((resolve) => child.once("exit", () => resolve(pid)));
}

const updateSpy = updateState as unknown as Mock & {
  conflicts: Array<(state: State) => void>;
};

function lockPath(): string {
  return `${join(process.env.OCM_STATE_DIR as string, "events.jsonl")}.lock`;
}

function eventsFor(id: string): ReturnType<typeof readEvents> {
  return readEvents().filter((e) => e.worker === id);
}

function readStateWorker(id: string): WorkerRecord | undefined {
  return loadState().workers[id];
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocm-monitor-"));
  process.env.OCM_STATE_DIR = dir;
  delete process.env.OCM_LOG_LEVEL;
  delete process.env.OCM_STALL_MS;
  updateSpy.conflicts.length = 0;
  mkdirSync(workersDir(), { recursive: true });
});

afterEach(() => {
  delete process.env.OCM_STATE_DIR;
  delete process.env.OCM_LOG_LEVEL;
  delete process.env.OCM_STALL_MS;
  updateSpy.conflicts.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

describe("appendEvent", () => {
  it("assigns a 1-based seq per line, works without a prior file, and frees the lock", () => {
    const first = appendEvent({ worker: "w1", owner: "own", kind: "started" });
    const second = appendEvent(
      { worker: "w2", owner: "own", kind: "limit", detail: FREE_LIMIT_DETAIL },
      NOW,
    );
    expect(first.seq).toBe(1);
    // the second event exercises the existing-file branch of the seq scan
    expect(second).toEqual({
      seq: 2,
      at: NOW.toISOString(),
      worker: "w2",
      owner: "own",
      kind: "limit",
      detail: FREE_LIMIT_DETAIL,
    });
    expect(readEvents()).toEqual([first, second]);
    expect(existsSync(lockPath())).toBe(false);
    expect(readLogs({ event: "monitor.event" })).toHaveLength(2);
  });

  it("removes a stale lock and treats an unstattable lock as stale", () => {
    writeFileSync(lockPath(), "999");
    const old = new Date(Date.now() - 20000);
    utimesSync(lockPath(), old, old);
    expect(appendEvent({ worker: "w1", owner: "own", kind: "started" }).seq).toBe(1);

    symlinkSync(join(dir, "gone"), lockPath());
    expect(appendEvent({ worker: "w1", owner: "own", kind: "started" }).seq).toBe(2);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("throws after ~2s when a fresh lock never frees", () => {
    writeFileSync(lockPath(), "999");
    expect(() => appendEvent({ worker: "w1", owner: "own", kind: "started" })).toThrow(
      "events lock busy",
    );
    expect(existsSync(lockPath())).toBe(true);
    rmSync(lockPath());
  }, 10000);

  it("throws on lock creation errors that are not contention", () => {
    // Assumes a non-root user: root bypasses directory permissions.
    const ro = join(dir, "read-only");
    mkdirSync(ro, 0o555);
    process.env.OCM_STATE_DIR = ro;
    try {
      expect(() => appendEvent({ worker: "w1", owner: "own", kind: "started" })).toThrow(
        /permission denied/i,
      );
    } finally {
      process.env.OCM_STATE_DIR = dir;
      chmodSync(ro, 0o755);
    }
  });
});

describe("readEvents", () => {
  it("returns [] when the event file does not exist", () => {
    expect(readEvents()).toEqual([]);
  });

  it("filters by owner and after sinceSeq, and skips corrupt lines", () => {
    appendEvent({ worker: "w1", owner: "o1", kind: "started" });
    appendEvent({ worker: "w2", owner: "o2", kind: "started" });
    appendEvent({ worker: "w3", owner: "o1", kind: "limit", detail: FREE_LIMIT_DETAIL });
    expect(readEvents({ owner: "o1" }).map((e) => e.worker)).toEqual(["w1", "w3"]);
    expect(readEvents({ owner: "o2", sinceSeq: 1 })).toEqual([expect.objectContaining({ seq: 2 })]);
    expect(readEvents({ sinceSeq: 1 }).map((e) => e.seq)).toEqual([2, 3]);
    expect(readEvents({ sinceSeq: 2 }).map((e) => e.seq)).toEqual([3]);
    expect(readEvents({ owner: "nope" })).toEqual([]);

    appendFileSync(join(dir, "events.jsonl"), "{oops\n");
    expect(readEvents().map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe("ingestWorker", () => {
  it("is idempotent on cold start against events already in the file", () => {
    appendEvent({ worker: "wc", owner: "o1", kind: "started" });
    appendEvent({ worker: "wc", owner: "o1", kind: "first_response" });
    appendEvent({ worker: "wc", owner: "o1", kind: "limit", detail: FREE_LIMIT_DETAIL });
    upsertWorker(worker("wc", { session: "ses_downstream" }));
    writeOut("wc", [TEXT_FIRST_EVENT, FREE_LIMIT_ERROR]);
    ingestWorker("wc", NOW);
    expect(eventsFor("wc").map((e) => e.kind)).toEqual(["started", "first_response", "limit"]);
    // markModelWorking still ran although the first_response event was deduped
    expect(Object.keys(loadState().cleared)).toEqual([MODEL]);
    // the file's session is ignored: the record already carries one
    const record = readStateWorker("wc") as WorkerRecord;
    expect(record.session).toBe("ses_downstream");
    expect(record.lastActivityAt).toBe(new Date(1793989303016).toISOString());
  });

  it("does nothing for an unknown id and for a worker without an output file", () => {
    ingestWorker("ghost");
    upsertWorker(worker("wi0"));
    ingestWorker("wi0");
    expect(readEvents()).toEqual([]);
    expect(loadState().cleared).toEqual({});
  });

  it("parses incrementally, waits for a partial trailing line, and captures the first session", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    upsertWorker(worker("wi"));
    // TEXT and STEP_START parse; the error line has no timestamp yet
    writeOut("wi", [TEXT_FIRST_EVENT, STEP_START_EVENT]);
    appendFileSync(outPath("wi"), '{"type":"error","timestamp":');
    ingestWorker("wi");
    expect(eventsFor("wi").map((e) => e.kind)).toEqual(["first_response"]);
    const record = readStateWorker("wi") as WorkerRecord;
    expect(record.session).toBe("ses_first_session");
    expect(record.lastActivityAt).toBe(new Date(1793989302189).toISOString());
    expect(loadState().cleared).toEqual({ [MODEL]: expect.any(String) });
    expect(readLogs({ event: "monitor.ingest" }).at(-1)).toMatchObject({ events: 2 });

    // completing the partial line plus new complete lines picks up where it stopped
    appendFileSync(outPath("wi"), `${FREE_LIMIT_ERROR.slice(FREE_LIMIT_ERROR.indexOf("1"))}\n`);
    appendFileSync(outPath("wi"), `${TEXT_LAST_EVENT}\n`); // second text: first_response must stay deduped
    appendFileSync(outPath("wi"), `${BARE_STEP_EVENT}\n`);
    ingestWorker("wi", NOW);
    expect(eventsFor("wi").map((e) => e.kind)).toEqual(["first_response", "limit"]);
    expect(eventsFor("wi").at(-1)?.detail).toBe(`free_usage until ${RESET_AT}`);
    // session already recorded: only the timestamp refreshes
    expect((readStateWorker("wi") as WorkerRecord).lastActivityAt).toBe(
      new Date(1793989303016).toISOString(),
    );

    // nothing new: parse and the record update are both skipped
    ingestWorker("wi");
    expect(eventsFor("wi")).toHaveLength(2);
    expect(readLogs({ event: "monitor.ingest" }).at(-1)).toMatchObject({
      worker: "wi",
      bytes: 0,
      events: 0,
    });
  });

  it("appends one limit event per distinct kind and skips corrupt lines", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    upsertWorker(worker("wl"));
    writeOut("wl", [
      FREE_LIMIT_ERROR,
      SECOND_FREE_LIMIT_ERROR, // same kind again: still only one event
      MODEL_DISABLED_ERROR,
      UNRECOGNIZED_ERROR, // not a recognized limit: no event
      "{oops\n", // corrupt JSON: skipped with a warn
      SESSION_NO_TS_EVENT, // refreshes the session, leaves the timestamp alone
      NO_SESSION_STEP_EVENT, // refreshes the timestamp alone
    ]);
    ingestWorker("wl", NOW);
    const limits = eventsFor("wl").filter((e) => e.kind === "limit");
    expect(limits.map((e) => e.detail)).toEqual([
      `free_usage until ${RESET_AT}`,
      "model_disabled until cleared by a successful run",
    ]);
    expect(readLogs({ event: "monitor.line_corrupt" })).toHaveLength(1);
    expect(readLogs({ event: "monitor.ingest" }).at(-1)).toMatchObject({ events: 6 });
    expect((readStateWorker("wl") as WorkerRecord).session).toBe("ses_first_session");
    expect((readStateWorker("wl") as WorkerRecord).lastActivityAt).toBe(
      new Date(1793989303300).toISOString(),
    );
  });

  it("captures a session from a timestamp-less event without touching activity", () => {
    upsertWorker(worker("wl2"));
    writeOut("wl2", [SESSION_NO_TS_EVENT]);
    ingestWorker("wl2", NOW);
    expect(eventsFor("wl2")).toEqual([]);
    expect((readStateWorker("wl2") as WorkerRecord).session).toBe("ses_first_session");
    expect((readStateWorker("wl2") as WorkerRecord).lastActivityAt).toBeUndefined();
  });
});

describe("sweep", () => {
  it("does nothing without workers", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    sweep();
    expect(readLogs({ event: "monitor.sweep" }).at(-1)).toMatchObject({
      workers: 0,
      running: 0,
      finished: 0,
      idled: 0,
      recovered: 0,
    });
  });

  it("appends started once for a running, alive worker", () => {
    upsertWorker(worker("sw1", { state: "running" }));
    upsertWorker(worker("sw1b", { state: "done" })); // finished records are not re-armed
    sweep();
    sweep();
    expect(eventsFor("sw1").map((e) => e.kind)).toEqual(["started"]);
    expect(eventsFor("sw1b")).toEqual([]);
  });

  it("marks a dead worker done on a clean step_finish:stop", async () => {
    process.env.OCM_LOG_LEVEL = "debug";
    const pid = await deadPid();
    upsertWorker(worker("sw2", { pid }));
    writeOut("sw2", [STEP_START_EVENT, FINISH_STOP_EVENT]);
    sweep();
    expect(eventsFor("sw2").map((e) => e.kind)).toEqual(["started", "done"]);
    expect(eventsFor("sw2").at(-1)?.detail).toBeUndefined();
    const record = readStateWorker("sw2") as WorkerRecord;
    expect(record.state).toBe("done");
    expect(record).not.toHaveProperty("endedAt");
    expect(readLogs({ event: "monitor.sweep" }).at(-1)).toMatchObject({
      workers: 1,
      running: 1,
      finished: 1,
    });
  });

  it("marks a dead worker failed with died naming the redacted stderr tail", async () => {
    process.env.OCM_LOG_LEVEL = "debug";
    const pid = await deadPid();
    upsertWorker(worker("sw3", { pid }));
    writeOut("sw3", [STEP_START_EVENT, TEXT_FIRST_EVENT]);
    writeFileSync(errPath("sw3"), "trace...\nerror: token=abc123secret xyz\nOK so far");
    sweep();
    const died = eventsFor("sw3").find((e) => e.kind === "died");
    expect(died?.detail).toBe("last event text; trace...\nerror: token=[redacted] xyz\nOK so far");
    const record = readStateWorker("sw3") as WorkerRecord;
    expect(record.state).toBe("failed");
    expect(record.endedAt).toBeTypeOf("string");
    expect(record.exitCode).toBeUndefined();
    expect(eventsFor("sw3").map((e) => e.kind)).toEqual(["started", "first_response", "died"]);
  });

  it("appends died without detail when the output and stderr are empty", async () => {
    const pid = await deadPid();
    upsertWorker(worker("sw4", { pid }));
    // no output file at all: the clean-end probe and the stderr tail come up empty
    writeFileSync(errPath("sw4"), "");
    sweep();
    const died = eventsFor("sw4").find((e) => e.kind === "died");
    expect(died?.detail).toBe("last event unknown");
    expect((readStateWorker("sw4") as WorkerRecord).state).toBe("failed");
  });

  it("treats an empty output file as no clean end", async () => {
    const pid = await deadPid();
    upsertWorker(worker("sw4b", { pid }));
    writeOut("sw4b", []); // the file exists but holds no complete event
    sweep();
    const died = eventsFor("sw4b").find((e) => e.kind === "died");
    expect(died?.detail).toBe("last event unknown");
    expect((readStateWorker("sw4b") as WorkerRecord).state).toBe("failed");
  });

  it("treats a corrupt last complete event as no clean end", async () => {
    const pid = await deadPid();
    upsertWorker(worker("sw5", { pid }));
    writeOut("sw5", [FINISH_STOP_EVENT, "{oops\n"]);
    sweep();
    expect((readStateWorker("sw5") as WorkerRecord).state).toBe("failed");
  });

  it("drops the stderr tail with a warn when it cannot be read", async () => {
    process.env.OCM_LOG_LEVEL = "debug";
    const pid = await deadPid();
    upsertWorker(worker("sw6", { pid }));
    writeOut("sw6", [TEXT_FIRST_EVENT]);
    mkdirSync(errPath("sw6")); // a directory instead of the log file
    sweep();
    const died = eventsFor("sw6").find((e) => e.kind === "died");
    expect(died?.detail).toBe("last event text");
    expect(readLogs({ event: "monitor.err_unreadable" })).toHaveLength(1);
  });

  it("keeps a running worker whose pid belongs to another user", () => {
    upsertWorker(worker("sw7", { pid: 1 }));
    sweep();
    expect((readStateWorker("sw7") as WorkerRecord).state).toBe("running");
  });

  // fixture-epoch clocks: stall sweeps must be near the event timestamps
  const STALL_SWEEP = new Date(1793989300100); // 100ms after the seeded startedAt
  const RECOVERY_SWEEP = new Date(1793989302230); // 41ms after the appended text event

  it("stalls an idle worker once using startedAt and recovers on new output", () => {
    process.env.OCM_STALL_MS = "50";
    upsertWorker(worker("sw8", { startedAt: new Date(1793989300000).toISOString() }));
    writeOut("sw8", [BARE_STEP_EVENT]); // no timestamp: lastActivityAt stays unset
    sweep(STALL_SWEEP);
    expect((readStateWorker("sw8") as WorkerRecord).state).toBe("stalled");
    expect(eventsFor("sw8").map((e) => e.kind)).toEqual(["started", "stalled"]);
    expect(eventsFor("sw8").at(-1)?.at).toBe(STALL_SWEEP.toISOString());
    sweep(NOW); // once only: no duplicate stalled event
    expect(eventsFor("sw8").filter((e) => e.kind === "stalled")).toHaveLength(1);

    appendFileSync(outPath("sw8"), `${TEXT_FIRST_EVENT}\n`);
    sweep(RECOVERY_SWEEP);
    expect((readStateWorker("sw8") as WorkerRecord).state).toBe("running");
    expect(eventsFor("sw8").map((e) => e.kind)).toEqual(["started", "stalled", "first_response"]);
  });

  it("stalls a running record without output and tolerates its missing file", () => {
    process.env.OCM_STALL_MS = "50";
    upsertWorker(worker("swA", { startedAt: new Date(1793989300000).toISOString() }));
    sweep(STALL_SWEEP); // no output file at all: stall decides on startedAt
    expect((readStateWorker("swA") as WorkerRecord).state).toBe("stalled");
    expect(eventsFor("swA").map((e) => e.kind)).toEqual(["started", "stalled"]);
    sweep(STALL_SWEEP); // pre-size probe of the missing file, no phantom recovery
    expect(eventsFor("swA").filter((e) => e.kind === "stalled")).toHaveLength(1);
    expect((readStateWorker("swA") as WorkerRecord).state).toBe("stalled");
  });

  it("stalls using lastActivityAt when present", () => {
    process.env.OCM_STALL_MS = "50";
    upsertWorker(worker("sw9", { lastActivityAt: new Date(1793900000000).toISOString() }));
    writeOut("sw9", [BARE_STEP_EVENT]); // no timestamp: lastActivityAt is not refreshed
    sweep(NOW);
    expect((readStateWorker("sw9") as WorkerRecord).state).toBe("stalled");
    expect(eventsFor("sw9").map((e) => e.kind)).toEqual(["started", "stalled"]);
  });

  it("does not finish a record another writer deleted", async () => {
    const pid = await deadPid();
    upsertWorker(worker("rc1", { pid }));
    writeOut("rc1", [STEP_START_EVENT]); // ingest's state update fires first
    updateSpy.conflicts.push((state) => {
      delete state.workers.rc1;
    });
    sweep();
    expect(readStateWorker("rc1")).toBeUndefined();
    // started is announced up front, before the other writer's delete lands
    expect(readEvents().map((e) => e.kind)).toEqual(["started"]);
  });

  it("does not finish a record another writer finalized", async () => {
    const pid = await deadPid();
    upsertWorker(worker("rc2", { pid }));
    writeOut("rc2", [BARE_STEP_EVENT]); // no session/timestamp: ingest leaves state alone
    updateSpy.conflicts.push((state) => {
      if (state.workers.rc2?.state === "running") state.workers.rc2.state = "killed";
    });
    sweep();
    expect((readStateWorker("rc2") as WorkerRecord).state).toBe("killed");
    expect(eventsFor("rc2").map((e) => e.kind)).toEqual(["started"]);
  });

  it("does not restall a record another writer finished", () => {
    process.env.OCM_STALL_MS = "50";
    upsertWorker(worker("rc3", { startedAt: new Date(NOW.getTime() - 5000).toISOString() }));
    writeOut("rc3", [BARE_STEP_EVENT]);
    updateSpy.conflicts.push((state) => {
      if (state.workers.rc3?.state === "running") state.workers.rc3.state = "failed";
    });
    sweep(NOW);
    expect((readStateWorker("rc3") as WorkerRecord).state).toBe("failed");
    expect(eventsFor("rc3").map((e) => e.kind)).toEqual(["started"]);
  });

  it("does not recover growth into a record another writer moved", async () => {
    const pid = await deadPid();
    // order matters: rc5's ingestion must be stalled before rc4's branch runs
    upsertWorker(worker("rc5", { pid }));
    upsertWorker(worker("rc4", { state: "stalled", startedAt: NOW.toISOString() }));
    upsertWorker(worker("rc6"));
    writeOut("rc5", [BARE_STEP_EVENT]); // no session/timestamp: ingest skips the state update
    writeOut("rc4", [BARE_STEP_EVENT]);
    writeOut("rc6", [STEP_START_EVENT]);
    let call = 0;
    updateSpy.conflicts.push((state) => {
      call++;
      // 1st write: rc6's ingest — stall rc5 from the outside, before the snapshot
      if (call === 1) {
        if (state.workers.rc5?.state === "running") state.workers.rc5.state = "stalled";
        return;
      }
      // 2nd write: rc5's recovery — move rc4 and grow its file underneath
      if (call === 2 && state.workers.rc4?.state === "stalled") {
        state.workers.rc4.state = "orphan";
        appendFileSync(outPath("rc4"), `${TEXT_LAST_EVENT}\n`);
      }
    });
    sweep(NOW);
    updateSpy.conflicts.length = 0;
    // rc5 was flipped to stalled by the hook mid-preflight, so it gets recovered
    // with the unknown pre-size default; rc4 stays whatever the hook set it to
    expect((readStateWorker("rc5") as WorkerRecord).state).toBe("running");
    expect((readStateWorker("rc4") as WorkerRecord).state).toBe("orphan");
    expect(eventsFor("rc4")).toEqual([]);
    expect(eventsFor("rc5").map((e) => e.kind)).toEqual(["started"]);
  });
});

describe("psRows", () => {
  it("summarizes workers newest first, filtered by owner, with optional fields", () => {
    const recent = new Date(Date.now() - 1100).toISOString();
    const older = new Date(Date.now() - 61000).toISOString();
    upsertWorker(worker("p1", { startedAt: recent, lastActivityAt: recent }));
    upsertWorker(worker("p2", { startedAt: older, owner: "o2" }));
    upsertWorker(worker("p3", { startedAt: older, ticket: undefined }));
    const rows = psRows();
    expect(rows.map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
    expect(rows[0]?.ageSec).toBe(1);
    expect(rows[0]?.idleSec).toBe(1);
    expect(rows[0]).toMatchObject({
      id: "p1",
      pid: process.pid,
      owner: "o1",
      ticket: "T1",
      model: MODEL,
      state: "running",
    });
    expect(rows[0]).not.toHaveProperty("session");
    expect(rows[1]?.ageSec).toBe(61);
    expect(rows[1]).not.toHaveProperty("idleSec");
    expect(rows[2]).not.toHaveProperty("ticket");
    expect(psRows("o2").map((r) => r.id)).toEqual(["p2"]);
    expect(psRows("none")).toEqual([]);
  });

  it("carries ticket, session and idle fields when present", () => {
    upsertWorker(worker("p3", { session: "ses_live", lastActivityAt: new Date().toISOString() }));
    const [row] = psRows();
    expect(row).toMatchObject({ ticket: "T1", session: "ses_live" });
    expect(row?.idleSec).toBe(0);
  });
});

describe("workerResult", () => {
  it("throws for an unknown worker", () => {
    expect(() => workerResult("missing")).toThrow("unknown worker: missing");
  });

  it("concatenates text events, skipping non-text lines, and truncates to the last maxChars", () => {
    const first = "response one";
    upsertWorker(worker("wr1", { state: "done", exitCode: 0 }));
    writeOut(
      "wr1",
      [
        `{"type":"text","timestamp":1,"sessionID":"s","part":{"type":"text","text":"${first}"}}`,
        "{oops",
        STEP_START_EVENT,
        TEXT_NO_PART_EVENT,
        TEXT_LAST_EVENT,
        '{"type":"text","timestamp":9', // partial trailing line: invisible
      ],
      false,
    );
    const result = workerResult("wr1");
    expect(result).toEqual({
      id: "wr1",
      state: "done",
      exitCode: 0,
      text: `${first}\nDone.`,
      diffStat: expect.any(String),
      truncated: false,
    });
    const cut = workerResult("wr1", 8);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe(`${first}\nDone.`.slice(-8));
  });

  it("returns empty text when the file holds only unparsable lines", () => {
    upsertWorker(worker("wr2", { state: "failed", exitCode: 3 }));
    writeOut("wr2", ["{corrupt only\n"]);
    const result = workerResult("wr2", 10);
    expect(result).toEqual({
      id: "wr2",
      state: "failed",
      exitCode: 3,
      text: "",
      diffStat: expect.anything(),
      truncated: false,
    });
  });

  it("returns empty text and an empty diffStat without an output file", () => {
    upsertWorker(worker("wr3", { cwd: dir })); // not a git repository either
    const result = workerResult("wr3");
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.diffStat).toBe("");
    expect(readLogs({ event: "monitor.git_failed" })).toHaveLength(1);
  });

  it("falls back to an empty diffStat and logs a warn when git fails", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    upsertWorker(worker("wr4", { cwd: dir })); // not a git repository
    writeOut("wr4", [TEXT_FIRST_EVENT]);
    const result = workerResult("wr4");
    expect(result.text).toBe("I'll start by reading the file.");
    expect(result.diffStat).toBe("");
    expect(readLogs({ event: "monitor.git_failed" })).toHaveLength(1);
  });
});

describe("waitForEvents", () => {
  it("returns existing matching events without waiting", async () => {
    appendEvent({ worker: "wv1", owner: "own", kind: "started" });
    const found = await waitForEvents({ owner: "own" });
    expect(found.map((e) => e.kind)).toEqual(["started"]);
  });

  it("wakes up when a matching event is appended while polling", async () => {
    appendEvent({ worker: "wv2", owner: "other", kind: "started" });
    const waiting = waitForEvents({ owner: "own", sinceSeq: 1, waitMs: 5000, pollMs: 20 });
    setTimeout(() => {
      appendEvent({ worker: "wv2", owner: "own", kind: "limit", detail: FREE_LIMIT_DETAIL });
    }, 150);
    const found = await waiting;
    expect(found.map((e) => [e.seq, e.kind])).toEqual([[2, "limit"]]);
  });

  it("returns [] on timeout while sweep keeps reconciling", async () => {
    // the worker's fresh activity keeps it well clear of any stall threshold
    process.env.OCM_STALL_MS = String(7 * 24 * 60 * 60 * 1000);
    upsertWorker(worker("wv3", { lastActivityAt: new Date().toISOString() }));
    writeOut("wv3", [TEXT_FIRST_EVENT]);
    const started = Date.now();
    const found = await waitForEvents({ owner: "ghost", waitMs: 200, pollMs: 60 });
    expect(found).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(eventsFor("wv3").map((e) => e.kind)).toEqual(["started", "first_response"]);
  });
});

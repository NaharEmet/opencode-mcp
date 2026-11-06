import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectHits, workersDir } from "../../../src/modules/ocm/evidence.js";
import { readLogs } from "../../../src/modules/ocm/log.js";
import { upsertWorker, type WorkerRecord } from "../../../src/modules/ocm/state.js";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const DAY_MS = 86_400_000;
const MODEL = "zai-coding-plan/glm-5.3-flash";
const PLAIN_MODEL = "glm-5.3-flash";

// The real ticket samples, verbatim (with literal \n escapes in the log line).
const SESSION_LINE =
  "timestamp=2026-11-06T18:30:33.373Z level=ERROR run=c395a701 " +
  'message="Failed to drain Session" cause="AI.Error: Weekly/Monthly Limit Exhausted. ' +
  "Your limit will reset at 2026-11-10 02:02:55\\n    at Rae (/$bunfs/root/chunk-ek0q9z0p.js:3:3633)\\n" +
  '  [cause]: AI.Error.QuotaExceeded: Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-10 02:02:55\\n}" ' +
  "role=server sessionID=ses_e4de7b36bffeGj9tzvdxjKmhOH";
const FREE_SESSION_LINE =
  "timestamp=2026-11-06T18:31:00.000Z level=ERROR run=c395a701 " +
  'message="Failed to drain Session" cause="AI.Error: Free usage limit reached. Free models ' +
  "work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: " +
  'https://opencode.ai/go\\n    at Rae (/$bunfs/root/chunk-ek0q9z0p.js:3:3633)" ' +
  "role=server sessionID=ses_e4de7b36bffeGj9tzvdxjKmhOH";
const STEP_START_EVENT =
  '{"type":"step_start","timestamp":1793989301108,"sessionID":"ses_e4de7b333ffehtj1J774fjIhKK","part":{}}';
// same sample with the drain-failure line's session, for attribution cases
const STEP_WITH_DRAIN_SESSION =
  '{"type":"step_start","timestamp":1793989301108,"sessionID":"ses_e4de7b36bffeGj9tzvdxjKmhOH","part":{}}';
const FREE_LIMIT_EVENT =
  '{"type":"error","timestamp":1793989303016,"sessionID":"ses_e4de7b333ffehtj1J774fjIhKK",' +
  '"error":{"type":"provider.free-limit","message":"Free usage limit reached. Connect a ' +
  'provider or subscribe to OpenCode Go to keep going, or switch models.","status":429,' +
  '"retryAfterMs":20313000}}';
const AUTH_EVENT =
  '{"type":"error","timestamp":1793990000000,"sessionID":"ses_e4de7b333ffehtj1J774fjIhKK",' +
  '"error":{"type":"provider.auth","message":"Model access is disabled","status":403}}';
const QUOTA_EVENT =
  '{"type":"error","timestamp":1793990000000,"sessionID":"ses_e4de7b333ffehtj1J774fjIhKK",' +
  '"error":{"type":"provider.quota","message":"This request requires more credits, or fewer' +
  ' max_tokens. You requested up to 256000 tokens, but can only afford 3774.","status":402}}';
const OLD_LOG_LINE =
  'timestamp=2026-11-05T09:00:00.000Z level=ERROR run=4f55e49a message=\\"stream error\\" ' +
  "providerID=zai-coding-plan modelID=glm-5.3-flash session.id=ses_x small=false agent=build " +
  'mode=primary error.error=\\"AI_APICallError: Usage limit reached for 5 hour\\"';

function worker(id: string, over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id,
    pid: 1,
    owner: "o",
    model: MODEL,
    cwd: "/tmp",
    startedAt: "2026-11-06T09:00:00.000Z",
    state: "running",
    ...over,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocm-evidence-"));
  process.env.OCM_STATE_DIR = dir;
  mkdirSync(workersDir(), { recursive: true });
});

afterEach(() => {
  delete process.env.OCM_STATE_DIR;
  delete process.env.OCM_LOG_LEVEL;
  rmSync(dir, { recursive: true, force: true });
});

describe("workersDir", () => {
  it("sits under the state dir logs", () => {
    expect(workersDir()).toBe(join(dir, "logs", "workers"));
  });
});

describe("collectHits", () => {
  it("returns [] and a zero summary for empty state and no log", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    expect(collectHits({ logPath: join(dir, "nope.log"), now: NOW })).toEqual([]);
    expect(readLogs({ event: "evidence.collected" }).at(-1)).toMatchObject({
      log: 0,
      worker: 0,
      session: 0,
    });
  });

  it("also works with no options, using the default window and log path", () => {
    expect(collectHits()).toEqual([]);
  });

  it("parses worker error events, de-dupes identical hits, and remembers the first session", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    // session already seeded: the file's first session must not overwrite it
    upsertWorker(worker("w1", { session: "ses_e4de7b333ffehtj1J774fjIhKK" }));
    const lines = [
      STEP_START_EVENT,
      FREE_LIMIT_EVENT,
      FREE_LIMIT_EVENT, // duplicate provider/model/kind/ts
      AUTH_EVENT,
      QUOTA_EVENT,
      "{oops", // corrupt JSON line
    ];
    writeFileSync(join(workersDir(), "w1.out.jsonl"), `${lines.join("\n")}\n`);
    const [free, auth, quota] = collectHits({ logPath: join(dir, "nope.log"), now: NOW });
    expect(free).toMatchObject({
      provider: "zai-coding-plan",
      model: "glm-5.3-flash",
      kind: "free_usage",
      ts: new Date(1793989303016).toISOString(),
      resetAt: new Date(1793989303016 + 20313000).toISOString(),
    });
    expect(auth).toMatchObject({ kind: "model_disabled" });
    expect(quota).toMatchObject({ kind: "insufficient_funds" });
    expect(readLogs({ event: "evidence.collected" }).at(-1)).toMatchObject({ worker: 4 });
  });

  it("attributes a session-keyed line through the first sessionID in the worker file", () => {
    upsertWorker(worker("w2"));
    // the file's own error carries a different session; the FIRST one wins
    writeFileSync(
      join(workersDir(), "w2.out.jsonl"),
      `${STEP_WITH_DRAIN_SESSION}\n${FREE_LIMIT_EVENT}\n`,
    );
    writeFileSync(join(dir, "opencode.log"), `${FREE_SESSION_LINE}\n`);
    const hits = collectHits({ logPath: join(dir, "opencode.log"), now: NOW });
    expect(hits).toEqual([
      expect.objectContaining({ kind: "free_usage", ts: new Date(1793989303016).toISOString() }),
      expect.objectContaining({
        kind: "free_usage",
        ts: "2026-11-06T18:31:00.000Z",
      }),
    ]);
    expect(hits[1].raw).toContain("sessionID=ses_e4de7b36bffeGj9tzvdxjKmhOH");
  });

  it("attributes a session-keyed line through WorkerRecord.session", () => {
    upsertWorker(worker("w3", { session: "ses_e4de7b36bffeGj9tzvdxjKmhOH" }));
    writeFileSync(join(dir, "opencode.log"), `${SESSION_LINE}\n`);
    expect(collectHits({ logPath: join(dir, "opencode.log"), now: NOW })).toEqual([
      {
        ts: "2026-11-06T18:30:33.373Z",
        provider: "zai-coding-plan",
        model: "glm-5.3-flash",
        kind: "weekly_monthly",
        resetAt: "2026-11-09T18:02:55.000Z",
        raw: SESSION_LINE,
      },
    ]);
  });

  it("keeps old-format log hits and merges all sources oldest first", () => {
    upsertWorker(worker("w4", { session: "ses_e4de7b36bffeGj9tzvdxjKmhOH" }));
    writeFileSync(join(workersDir(), "w4.out.jsonl"), `${QUOTA_EVENT}\n`);
    writeFileSync(join(dir, "opencode.log"), `${SESSION_LINE}\n${OLD_LOG_LINE}\n`);
    const hits = collectHits({ logPath: join(dir, "opencode.log"), now: NOW });
    expect(hits.map((h) => [h.kind, h.ts])).toEqual([
      ["five_hour", "2026-11-05T09:00:00.000Z"],
      ["weekly_monthly", "2026-11-06T18:30:33.373Z"],
      ["insufficient_funds", new Date(1793990000000).toISOString()],
    ]);
  });

  it("drops an unattributable session line and only warns when hits were attributed", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    upsertWorker(worker("w5", { session: "ses_other" }));
    writeFileSync(join(dir, "opencode.log"), `${SESSION_LINE}\n`);
    expect(collectHits({ logPath: join(dir, "opencode.log"), now: NOW })).toEqual([]);
    expect(readLogs({ event: "evidence.session_unattributed" })).toHaveLength(1);
    expect(readLogs({ event: "evidence.unattributed_sessions" })).toHaveLength(0);

    // with an attributed session hit alongside, the drop is called out
    writeFileSync(join(workersDir(), "w5.out.jsonl"), `${QUOTA_EVENT}\n`);
    expect(collectHits({ logPath: join(dir, "opencode.log"), now: NOW })).toHaveLength(1);
    expect(readLogs({ event: "evidence.unattributed_sessions" })).toHaveLength(1);
  });

  it("skips workers outside the sinceMs window even when they have hits", () => {
    upsertWorker(worker("w6", { startedAt: new Date(NOW.getTime() - 8 * DAY_MS).toISOString() }));
    writeFileSync(join(workersDir(), "w6.out.jsonl"), `${FREE_LIMIT_EVENT}\n`);
    expect(collectHits({ logPath: join(dir, "nope.log"), now: NOW })).toEqual([]);
  });

  it("tolerates a missing worker output file", () => {
    upsertWorker(worker("w7"));
    expect(collectHits({ logPath: join(dir, "nope.log"), now: NOW })).toEqual([]);
    expect(readLogs({ event: "evidence.worker_unreadable" })).toHaveLength(0);
  });

  it("warns and continues when a worker output file is unreadable", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    upsertWorker(worker("w8"));
    mkdirSync(join(workersDir(), "w8.out.jsonl")); // a directory, not a file
    expect(collectHits({ logPath: join(dir, "nope.log"), now: NOW })).toEqual([]);
    expect(readLogs({ event: "evidence.worker_unreadable" })).toHaveLength(1);

    upsertWorker(worker("w9"));
    writeFileSync(join(workersDir(), "w9.out.jsonl"), `${FREE_LIMIT_EVENT}\n`);
    expect(collectHits({ logPath: join(dir, "nope.log"), now: NOW })).toHaveLength(1);
  });

  it("warns when the opencode.log tail cannot be read at all", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    expect(collectHits({ logPath: dir, now: NOW })).toEqual([]); // directory throws EISDIR
    expect(readLogs({ event: "evidence.log_unreadable" })).toHaveLength(1);
  });

  it("splits a worker model without a slash into an empty provider", () => {
    upsertWorker(worker("w10", { model: PLAIN_MODEL, session: "ses_e4de7b36bffeGj9tzvdxjKmhOH" }));
    writeFileSync(join(dir, "opencode.log"), `${SESSION_LINE}\n`);
    expect(collectHits({ logPath: join(dir, "opencode.log"), now: NOW })).toEqual([
      expect.objectContaining({ provider: "", model: PLAIN_MODEL, kind: "weekly_monthly" }),
    ]);
  });
});

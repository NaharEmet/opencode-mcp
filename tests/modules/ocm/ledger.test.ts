import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyVerdict,
  type DispatchRecord,
  exportPolicy,
  importPolicy,
  type Ledger,
  loadLedger,
  type ModelEntry,
  pick,
  poolOf,
  recordDispatch,
  updateLedger,
  usageFromOutput,
} from "../../../src/modules/ocm/ledger.js";
import { readLogs } from "../../../src/modules/ocm/log.js";

let dir: string;

const T = "2026-01-01T00:00:00.000Z";

// Trimmed copy of ~/.claude/model-policy.md: pools table plus the four free rows.
const FIXTURE = `# Global model policy — tiers, difficulty, trial ladder

## Three pools — spend all of them, in parallel

| Pool | Ids | Limit / failure mode | Use for |
| ---- | --- | -------------------- | ------- |
| **OpenCode free (Zen)** | \`opencode/*-free\` | no dollar cost | first choice for D1–D2 |
| **Z.AI Coding Plan** | \`zai-coding-plan/glm-5.3-flash\`, \`glm-5.3\` | own subscription quota | D2–D3 volume work |
| **OpenCode Go (paid)** | \`opencode-go/*\` | one shared dollar budget | reserve |

Spreading rule: read quota with \`opencode_list_agents\` and grep \`opencode.log\` for walls.

## Speed and capability tiers

| Model | Speed | Strength | Max difficulty | Trial record | Evidence / best for |
| ----- | ----- | -------- | -------------- | ------------ | ------------------- |
| \`opencode/deepseek-v4.1-flash-free\` | unrated | unrated | D1 | 0 pass / 0 strike | user-set default; read-only review looked good |
| \`opencode/glm-5.3-flash-free\` | unrated | unrated | D1 | 0 pass / 0 strike | multi-step tickets; can stall silently on reviews |
| \`opencode/mimo-v2.6-flash-free\` | unrated | unrated | D1 | 0 pass / 0 strike | schema, scaffold, docs |
| \`opencode/nemotron-3-ultra-free\` | unrated | unrated | D1 | 0 pass / 0 strike | read-only review; some false positives |

**Ticket difficulty:** D1 mechanical; D2 feature; D3 multi-file; D4 risky.
`;

const MESSY = `## Speed and capability tiers

| Model | Speed | Strength | Max difficulty | Trial record | Evidence / best for |
| ----- | ----- | -------- | -------------- | ------------ | ------------------- |
| \`vendor/raw-model\` | fast | strong | D2 | 2 pass / 1 strike | quick |
| vendor/plain-id | medium | light | D3 | no record | unbackticked |
| \`vendor/wild-speed\` | blazing | cosmic | D1 | 0 pass / 0 strike | odd |
| \`vendor/no-difficulty\` | fast | light | hard | 0 pass / 0 strike | skip |
| \`vendor/benched-one\` | slow | strong | D2 | benched after 3 strikes | was flaky |
| \`vendor/five-cells\` | fast | strong | D1 | 0 pass / 0 strike |
|  | fast | strong | D1 | 0 pass / 0 strike | no id |
| \`vendor/short\` | two | cells |
|
`;

function entry(id: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id,
    pool: poolOf(id),
    speed: "unrated",
    strength: "unrated",
    maxDifficulty: 1,
    passes: 0,
    strikes: 0,
    streak: 0,
    benched: false,
    totals: { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, wallSec: 0 },
    ...overrides,
  };
}

function seed(overrides: Partial<ModelEntry> & { id: string }): ModelEntry {
  return updateLedger((ledger) => {
    const model = entry(overrides.id, overrides);
    ledger.models[model.id] = model;
    return model;
  });
}

function dispatch(model: string, overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    worker: "w1",
    ts: T,
    model,
    wallSec: 10,
    costUsd: 0.25,
    tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    outcome: "done",
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocm-ledger-"));
  process.env.OCM_STATE_DIR = dir;
});

afterEach(() => {
  delete process.env.OCM_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("poolOf", () => {
  it.each([
    ["opencode/deepseek-v4.1-flash-free", "free"],
    ["opencode/glm-5.3", "other"],
    ["zai-coding-plan/glm-5.3-flash", "zai"],
    ["opencode-go/kimi-k2", "go"],
    ["anthropic/claude", "other"],
  ])("maps %s to %s", (id, pool) => {
    expect(poolOf(id)).toBe(pool);
  });
});

describe("loadLedger", () => {
  it("returns an empty ledger when nothing is on disk", () => {
    expect(loadLedger()).toEqual({ version: 1, models: {} });
  });

  it("persists and reloads every field", () => {
    const model = seed({
      id: "opencode-go/kimi",
      pool: "go",
      speed: "fast",
      strength: "strong",
      maxDifficulty: 4,
      passes: 2,
      strikes: 1,
      streak: 1,
      listPrice: { inputPerM: 0.5, outputPerM: 1.5 },
      notes: "reserve",
    });
    expect(loadLedger().models["opencode-go/kimi"]).toEqual(model);
  });

  it("falls back to ledger.json.bak when the primary is corrupt", () => {
    importPolicy(FIXTURE);
    const good = loadLedger();
    writeFileSync(join(dir, "ledger.json"), "garbage");
    writeFileSync(`${join(dir, "ledger.json")}.bak`, JSON.stringify(good));
    expect(loadLedger()).toEqual(good);
    expect(readLogs({ level: "error", event: "ledger.corrupt" }).length).toBe(1);
  });

  it("returns an empty ledger when the primary is corrupt and no backup exists", () => {
    writeFileSync(join(dir, "ledger.json"), '{"version":2}');
    expect(loadLedger()).toEqual({ version: 1, models: {} });
    expect(readLogs({ level: "error", event: "ledger.corrupt" }).length).toBe(1);
  });

  it("returns an empty ledger when primary and backup are corrupt", () => {
    writeFileSync(join(dir, "ledger.json"), "garbage");
    writeFileSync(`${join(dir, "ledger.json")}.bak`, "also garbage");
    expect(loadLedger()).toEqual({ version: 1, models: {} });
    expect(readLogs({ level: "error", event: "ledger.corrupt" }).length).toBe(2);
  });

  it.each([
    ["null payload", "null"],
    ["missing models", '{"version":1}'],
  ])("treats %s as %s", (_name, raw) => {
    writeFileSync(join(dir, "ledger.json"), raw);
    expect(loadLedger()).toEqual({ version: 1, models: {} });
  });
});

describe("updateLedger", () => {
  it("returns the fn result and persists its mutations", () => {
    const id = updateLedger((ledger) => {
      ledger.models["m/x"] = entry("m/x");
      return ledger.models["m/x"]?.id;
    });
    expect(id).toBe("m/x");
    expect(loadLedger().models["m/x"]?.id).toBe("m/x");
  });

  it("releases the lock when fn throws", () => {
    expect(() =>
      updateLedger(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${join(dir, "ledger.json")}.lock`)).toBe(false);
    expect(updateLedger(() => 42)).toBe(42);
  });

  it("removes a stale lock", () => {
    const lock = `${join(dir, "ledger.json")}.lock`;
    writeFileSync(lock, "999");
    const old = new Date(Date.now() - 20000);
    utimesSync(lock, old, old);
    expect(updateLedger((ledger) => ledger.version)).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("treats an unstattable lock as stale", () => {
    const lock = `${join(dir, "ledger.json")}.lock`;
    symlinkSync(join(dir, "gone"), lock);
    expect(updateLedger((ledger) => ledger.version)).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("throws after ~2s when a fresh lock never frees", () => {
    const lock = `${join(dir, "ledger.json")}.lock`;
    writeFileSync(lock, "999");
    expect(() => updateLedger((ledger) => ledger.version)).toThrow("ledger lock busy");
    expect(existsSync(lock)).toBe(true);
  }, 10000);

  it("throws immediately on lock creation errors that are not contention", () => {
    // Assumes a non-root user: root bypasses directory permissions.
    const ro = join(dir, "read-only");
    mkdirSync(ro, 0o555);
    process.env.OCM_STATE_DIR = ro;
    try {
      expect(() => updateLedger((ledger) => ledger.version)).toThrow(/permission denied/i);
    } finally {
      process.env.OCM_STATE_DIR = dir;
      chmodSync(ro, 0o755);
    }
  });
});

describe("importPolicy", () => {
  it("imports the four free rows and seeds pool-table ids", () => {
    expect(importPolicy(FIXTURE)).toBe(4);
    const models = loadLedger().models;
    expect(Object.keys(models).sort()).toEqual([
      "opencode/deepseek-v4.1-flash-free",
      "opencode/glm-5.3-flash-free",
      "opencode/mimo-v2.6-flash-free",
      "opencode/nemotron-3-ultra-free",
      "zai-coding-plan/glm-5.3-flash",
    ]);
    expect(models["opencode/deepseek-v4.1-flash-free"]).toMatchObject({
      pool: "free",
      speed: "unrated",
      strength: "unrated",
      maxDifficulty: 1,
      passes: 0,
      strikes: 0,
      streak: 0,
      benched: false,
      notes: "user-set default; read-only review looked good",
    });
    expect(models["zai-coding-plan/glm-5.3-flash"]).toMatchObject({
      pool: "zai",
      speed: "unrated",
      strength: "unrated",
      maxDifficulty: 1,
    });
    expect(models["zai-coding-plan/glm-5.3-flash"]?.notes).toBeUndefined();
  });

  it("keeps totals and streak on re-import but takes passes/strikes from the row", () => {
    importPolicy(FIXTURE);
    const id = "opencode/deepseek-v4.1-flash-free";
    recordDispatch(dispatch(id, { verdict: "pass" }));
    expect(importPolicy(FIXTURE)).toBe(4);
    const deep = loadLedger().models[id];
    expect(deep?.totals).toEqual({
      runs: 1,
      costUsd: 0.25,
      inputTokens: 100,
      outputTokens: 50,
      wallSec: 10,
    });
    expect(deep?.streak).toBe(1);
    expect(deep?.passes).toBe(0);
    expect(deep?.strikes).toBe(0);
    expect(readLogs({ level: "info", event: "ledger.import" }).length).toBe(2);
  });

  it("does not reset pool-seeded entries that are not in the tiers table", () => {
    importPolicy(FIXTURE);
    applyVerdict("zai-coding-plan/glm-5.3-flash", "pass");
    importPolicy(FIXTURE);
    expect(loadLedger().models["zai-coding-plan/glm-5.3-flash"]?.passes).toBe(1);
  });

  it("parses messy rows: tiers, benched marks, junk skipped", () => {
    expect(importPolicy(MESSY)).toBe(5);
    const models = loadLedger().models;
    expect(Object.keys(models).sort()).toEqual([
      "vendor/benched-one",
      "vendor/five-cells",
      "vendor/plain-id",
      "vendor/raw-model",
      "vendor/wild-speed",
    ]);
    expect(models["vendor/raw-model"]).toMatchObject({
      pool: "other",
      speed: "fast",
      strength: "strong",
      maxDifficulty: 2,
      passes: 2,
      strikes: 1,
      benched: false,
      notes: "quick",
    });
    expect(models["vendor/plain-id"]).toMatchObject({
      speed: "medium",
      strength: "light",
      maxDifficulty: 3,
    });
    expect(models["vendor/wild-speed"]).toMatchObject({ speed: "unrated", strength: "unrated" });
    expect(models["vendor/benched-one"]).toMatchObject({
      speed: "slow",
      maxDifficulty: 2,
      passes: 0,
      strikes: 3,
      benched: true,
    });
    expect(models["vendor/five-cells"]?.notes).toBeUndefined();
  });

  it("returns 0 for markdown without the tiers table", () => {
    expect(importPolicy("no tables here")).toBe(0);
  });
});

describe("exportPolicy", () => {
  it("round-trips the fixture byte-for-byte when the ledger matches it", () => {
    importPolicy(FIXTURE);
    updateLedger((ledger) => {
      delete ledger.models["zai-coding-plan/glm-5.3-flash"];
    });
    expect(exportPolicy(FIXTURE, loadLedger())).toBe(FIXTURE);
  });

  it("replaces only the tier rows and sorts by pool then id", () => {
    importPolicy(FIXTURE);
    applyVerdict("opencode/glm-5.3-flash-free", "pass");
    applyVerdict("opencode/nemotron-3-ultra-free", "strike");
    applyVerdict("opencode/nemotron-3-ultra-free", "strike");
    applyVerdict("opencode/nemotron-3-ultra-free", "strike");
    seed({ id: "opencode-go/kimi-k2" });
    const out = exportPolicy(FIXTURE, loadLedger());
    const head = FIXTURE.slice(0, FIXTURE.indexOf("| `opencode/deepseek"));
    const tail = FIXTURE.slice(FIXTURE.indexOf("\n\n**Ticket difficulty"));
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(out.split("\n").filter((line) => line.startsWith("| `"))).toEqual([
      "| `opencode/deepseek-v4.1-flash-free` | unrated | unrated | D1 | 0 pass / 0 strike | user-set default; read-only review looked good |",
      "| `opencode/glm-5.3-flash-free` | unrated | unrated | D1 | 1 pass / 0 strike | multi-step tickets; can stall silently on reviews |",
      "| `opencode/mimo-v2.6-flash-free` | unrated | unrated | D1 | 0 pass / 0 strike | schema, scaffold, docs |",
      "| `opencode/nemotron-3-ultra-free` | unrated | unrated | D1 | benched | read-only review; some false positives |",
      "| `zai-coding-plan/glm-5.3-flash` | unrated | unrated | D1 | 0 pass / 0 strike |  |",
      "| `opencode-go/kimi-k2` | unrated | unrated | D1 | 0 pass / 0 strike |  |",
    ]);
  });

  it("fills an empty table without touching other bytes", () => {
    importPolicy(FIXTURE);
    const empty = FIXTURE.replace(/^\| `opencode\/.*$\n/gm, "");
    const out = exportPolicy(empty, loadLedger());
    expect(out.split("\n").filter((line) => line.startsWith("| `")).length).toBe(5);
    expect(out.startsWith(empty.slice(0, empty.indexOf("| ----- |")))).toBe(true);
    expect(
      out.endsWith(
        "\n\n**Ticket difficulty:** D1 mechanical; D2 feature; D3 multi-file; D4 risky.\n",
      ),
    ).toBe(true);
  });

  it("writes rows when the table ends at EOF", () => {
    seed({ id: "m/x" });
    const text = "# t\n\n## Speed and capability tiers\n\n| Model | Speed |\n| ----- | ----- |";
    const out = exportPolicy(text, { version: 1, models: { "m/x": entry("m/x") } });
    expect(out.endsWith("| `m/x` | unrated | unrated | D1 | 0 pass / 0 strike |  |")).toBe(true);
  });

  it("returns the text unchanged and warns when the table is missing", () => {
    const text = "# policy\n\nno tables here\n";
    expect(exportPolicy(text, { version: 1, models: {} })).toBe(text);
    expect(readLogs({ level: "warn", event: "ledger.export.no_table" }).length).toBe(1);
  });

  it("returns the text unchanged when the heading has no separator", () => {
    const prose = "## Speed and capability tiers\n\njust prose\n\n## Next\n";
    expect(exportPolicy(prose, { version: 1, models: {} })).toBe(prose);
    const atEof = "## Speed and capability tiers\n\nstill no table";
    expect(exportPolicy(atEof, { version: 1, models: {} })).toBe(atEof);
    expect(readLogs({ level: "warn", event: "ledger.export.no_table" }).length).toBe(2);
  });
});

describe("usageFromOutput", () => {
  it("sums step_finish events and skips everything else", () => {
    const path = join(dir, "w1.out.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "step_finish",
          timestamp: 1,
          sessionID: "s",
          part: {
            type: "step-finish",
            reason: "stop",
            cost: 0.25,
            tokens: { input: 650, output: 598, reasoning: 12, cache: { read: 40256, write: 30 } },
          },
        }),
        "not json",
        JSON.stringify({ type: "other", part: { cost: 999 } }),
        JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "tool" } }),
        JSON.stringify({
          type: "step_finish",
          part: { cost: "oops", tokens: { input: "x", output: 10, cache: { read: 5 } } },
        }),
        "",
        JSON.stringify({
          type: "step_finish",
          part: {
            cost: 1.5,
            tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        }),
      ].join("\n"),
    );
    expect(usageFromOutput(path)).toEqual({
      costUsd: 1.75,
      tokens: { input: 750, output: 808, reasoning: 12, cacheRead: 40261, cacheWrite: 30 },
      steps: 4,
    });
  });

  it("returns zeros for a missing file", () => {
    expect(usageFromOutput(join(dir, "nope.out.jsonl"))).toEqual({
      costUsd: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      steps: 0,
    });
  });
});

describe("recordDispatch", () => {
  it("creates unknown models and appends the record", () => {
    recordDispatch(dispatch("opencode-go/kimi", { ticket: "T1", difficulty: 3 }));
    const model = loadLedger().models["opencode-go/kimi"];
    expect(model).toMatchObject({
      pool: "go",
      speed: "unrated",
      strength: "unrated",
      maxDifficulty: 1,
    });
    expect(model?.totals).toEqual({
      runs: 1,
      costUsd: 0.25,
      inputTokens: 100,
      outputTokens: 50,
      wallSec: 10,
    });
    const lines = readFileSync(join(dir, "dispatches.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ model: "opencode-go/kimi", ticket: "T1" });
    expect(readLogs({ level: "info", event: "ledger.dispatch" }).length).toBe(1);
  });

  it("accumulates totals on known models and applies the verdict", () => {
    importPolicy(FIXTURE);
    const id = "opencode/deepseek-v4.1-flash-free";
    recordDispatch(dispatch(id, { verdict: "pass" }));
    recordDispatch(dispatch(id, { costUsd: 0.5, outcome: "failed" }));
    const model = loadLedger().models[id];
    expect(model?.totals).toEqual({
      runs: 2,
      costUsd: 0.75,
      inputTokens: 200,
      outputTokens: 100,
      wallSec: 20,
    });
    expect(model).toMatchObject({ passes: 1, strikes: 0, streak: 1 });
  });
});

describe("applyVerdict", () => {
  it("promotes after two passes in a row and caps at D3", () => {
    importPolicy(FIXTURE);
    const id = "opencode/deepseek-v4.1-flash-free";
    expect(applyVerdict(id, "pass")).toMatchObject({ passes: 1, streak: 1, maxDifficulty: 1 });
    expect(applyVerdict(id, "pass")).toMatchObject({ passes: 2, streak: 0, maxDifficulty: 2 });
    applyVerdict(id, "pass");
    expect(applyVerdict(id, "pass")).toMatchObject({ passes: 4, streak: 0, maxDifficulty: 3 });
    applyVerdict(id, "pass");
    expect(applyVerdict(id, "pass")).toMatchObject({ passes: 6, streak: 2, maxDifficulty: 3 });
  });

  it("demotes after three strikes above D1 and benches at D1", () => {
    const id = "vendor/d2";
    seed({ id, pool: "other", maxDifficulty: 2 });
    applyVerdict(id, "strike");
    applyVerdict(id, "strike");
    expect(applyVerdict(id, "strike")).toMatchObject({
      maxDifficulty: 1,
      strikes: 0,
      benched: false,
    });
    applyVerdict(id, "strike");
    applyVerdict(id, "strike");
    expect(applyVerdict(id, "strike")).toMatchObject({ maxDifficulty: 1, benched: true });
  });

  it("throws for an unknown model and releases the lock", () => {
    expect(() => applyVerdict("ghost", "pass")).toThrow("unknown model: ghost");
    expect(existsSync(`${join(dir, "ledger.json")}.lock`)).toBe(false);
  });
});

describe("pick", () => {
  it("ranks by pool order first", () => {
    seed({ id: "vendor/other", pool: "other", maxDifficulty: 2 });
    seed({ id: "opencode-go/paid", pool: "go", maxDifficulty: 2 });
    seed({ id: "zai-coding-plan/glm", pool: "zai", maxDifficulty: 2 });
    seed({ id: "free/a", pool: "free", maxDifficulty: 2 });
    expect(pick({ difficulty: 2 }).map((p) => p.id)).toEqual([
      "free/a",
      "zai-coding-plan/glm",
      "opencode-go/paid",
      "vendor/other",
    ]);
  });

  it("prefers lower observed cost, then faster speed, then id within a pool", () => {
    seed({
      id: "free/b",
      pool: "free",
      totals: { runs: 4, costUsd: 1, inputTokens: 0, outputTokens: 0, wallSec: 0 },
    });
    seed({
      id: "free/a",
      pool: "free",
      totals: { runs: 2, costUsd: 1, inputTokens: 0, outputTokens: 0, wallSec: 0 },
    });
    seed({ id: "free/z", pool: "free", speed: "unrated" });
    seed({ id: "free/y", pool: "free", speed: "fast" });
    const picks = pick({ difficulty: 1 });
    expect(picks.map((p) => p.id)).toEqual(["free/y", "free/z", "free/b", "free/a"]);
    expect(picks[2]?.reason).toBe("free pool, 0 running, avg $0.2500/run");
    expect(picks[3]?.reason).toBe("free pool, 0 running, avg $0.5000/run");
  });

  it("reports per-pool running load in the reason", () => {
    seed({ id: "free/a", pool: "free" });
    seed({ id: "free/b", pool: "free" });
    seed({ id: "zai-coding-plan/glm", pool: "zai" });
    const picks = pick({
      difficulty: 1,
      running: { "free/a": 1, "free/b": 2, "zai-coding-plan/glm": 5 },
    });
    expect(picks.map((p) => p.reason)).toEqual([
      "free pool, 3 running, avg $0.0000/run",
      "free pool, 3 running, avg $0.0000/run",
      "zai pool, 5 running, avg $0.0000/run",
    ]);
  });

  it("applies the benched, difficulty, blocked and exclude filters", () => {
    seed({ id: "free/a", pool: "free", maxDifficulty: 3 });
    seed({ id: "free/b", pool: "free", maxDifficulty: 4, benched: true });
    seed({ id: "free/c", pool: "free", maxDifficulty: 1 });
    seed({ id: "free/d", pool: "free", maxDifficulty: 3 });
    seed({ id: "free/e", pool: "free", maxDifficulty: 3 });
    const picks = pick({ difficulty: 3, blocked: new Set(["free/d"]), exclude: ["free/e"] });
    expect(picks.map((p) => p.id)).toEqual(["free/a"]);
  });

  it("returns an empty list and logs the filter counts when nothing qualifies", () => {
    seed({ id: "free/a", pool: "free", maxDifficulty: 1, benched: true });
    expect(pick({ difficulty: 2 })).toEqual([]);
    const logged = readLogs({ level: "warn", event: "ledger.pick.empty" }).at(-1);
    expect(logged).toMatchObject({
      difficulty: 2,
      considered: 1,
      benched: 1,
      tooWeak: 0,
      blocked: 0,
      excluded: 0,
    });
  });
});

describe("ledger round trip through disk", () => {
  it("survives a full import/dispatch/export cycle", () => {
    importPolicy(FIXTURE);
    recordDispatch(dispatch("zai-coding-plan/glm-5.3-flash", { verdict: "pass", wallSec: 42 }));
    const ledger: Ledger = loadLedger();
    const glm = ledger.models["zai-coding-plan/glm-5.3-flash"];
    expect(glm).toMatchObject({ passes: 1, streak: 1 });
    expect(glm?.totals.runs).toBe(1);
    expect(exportPolicy(FIXTURE, ledger).split("\n")).toContain(
      "| `zai-coding-plan/glm-5.3-flash` | unrated | unrated | D1 | 1 pass / 0 strike |  |",
    );
  });
});

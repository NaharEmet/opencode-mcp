import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendWorkerOutput,
  createLogger,
  errorFields,
  installCrashLogging,
  log,
  readLogs,
  redact,
  serverLogPath,
  stateDir,
  workerLogPath,
} from "../../../src/modules/ocm/log.js";

let dir: string;

// A state dir nested under a regular file: mkdir fails with ENOTDIR straight away.
function blockedDir(): string {
  const file = join(dir, "not-a-dir");
  writeFileSync(file, "");
  return join(file, "state");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocm-log-"));
  process.env.OCM_STATE_DIR = dir;
  delete process.env.OCM_LOG_LEVEL;
});

afterEach(() => {
  delete process.env.OCM_STATE_DIR;
  delete process.env.XDG_STATE_HOME;
  delete process.env.OCM_LOG_LEVEL;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("stateDir", () => {
  it("uses OCM_STATE_DIR verbatim", () => {
    expect(stateDir()).toBe(dir);
  });

  it("falls back to XDG_STATE_HOME then the home directory", () => {
    delete process.env.OCM_STATE_DIR;
    process.env.XDG_STATE_HOME = "/x";
    expect(stateDir()).toBe("/x/opencode-worker-server");
    delete process.env.XDG_STATE_HOME;
    expect(stateDir()).toMatch(/\.local\/state\/opencode-worker-server$/);
  });

  it("sanitises worker ids in file names", () => {
    expect(workerLogPath("a/b c")).toBe(join(dir, "logs", "workers", "a_b_c.log"));
  });
});

describe("redact", () => {
  it("masks keys, bearer tokens and key-named fields", () => {
    expect(redact("key sk-abcdefghijklmnopqrstuvwx end")).toBe("key sk-[redacted] end");
    expect(redact("Authorization: Bearer abc.def")).toContain("Bearer [redacted]");
    expect(redact('{"apiKey":"hunter2"}')).toContain("[redacted]");
    expect(redact({ apiKey: "v", nested: [{ password: "p", ok: "fine" }], n: 3 })).toEqual({
      apiKey: "[redacted]",
      nested: [{ password: "[redacted]", ok: "fine" }],
      n: 3,
    });
    expect(redact(null)).toBeNull();
  });

  it("flattens errors", () => {
    const out = redact(new Error("boom"));
    expect(out).toMatchObject({ name: "Error", message: "boom" });
    expect(errorFields("plain")).toEqual({ message: "plain" });
  });
});

describe("log", () => {
  it("writes redacted JSON lines with ts, level and event", () => {
    log("info", "worker.launch", {
      worker: "w1",
      argv: ["--key", "x"],
      api_key: "sk-secretsecretsecret1",
    });
    const [entry] = readLogs();
    expect(entry).toMatchObject({ level: "info", event: "worker.launch", worker: "w1" });
    expect(entry.api_key).toBe("[redacted]");
    expect(new Date(entry.ts).toString()).not.toBe("Invalid Date");
  });

  it("drops lines below OCM_LOG_LEVEL", () => {
    process.env.OCM_LOG_LEVEL = "warn";
    log("info", "quiet");
    log("error", "loud");
    expect(readLogs().map((e) => e.event)).toEqual(["loud"]);
  });

  it("never throws when the log path is unwritable", () => {
    process.env.OCM_STATE_DIR = blockedDir();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => log("info", "x")).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });

  it("rotates server.log past 10 MB and keeps three generations", () => {
    log("info", "seed");
    const path = serverLogPath();
    for (let round = 0; round < 5; round++) {
      writeFileSync(path, "x".repeat(10 * 1024 * 1024));
      log("info", `round${round}`);
    }
    expect(readFileSync(`${path}.1`, "utf8").length).toBeGreaterThan(10_000_000);
    expect(readFileSync(`${path}.3`, "utf8").length).toBeGreaterThan(10_000_000);
    expect(() => readFileSync(`${path}.4`)).toThrow();
  });
});

describe("createLogger", () => {
  it("stamps base fields and merges child fields", () => {
    const logger = createLogger({ request_id: "r1" }).child({ manager: "m1" });
    logger.debug("d");
    logger.info("i", { worker: "w" });
    logger.warn("w");
    logger.error("e");
    const entries = readLogs();
    expect(entries.map((e) => e.event)).toEqual(["i", "w", "e"]);
    expect(entries[0]).toMatchObject({ request_id: "r1", manager: "m1", worker: "w" });
  });
});

describe("appendWorkerOutput", () => {
  it("keeps redacted, timestamped lines per worker", () => {
    appendWorkerOutput("w1", "stdout", "hello\n\nsk-abcdefghijklmnopqrstuvwx\n");
    appendWorkerOutput("w1", "stderr", "\n");
    const lines = readFileSync(workerLogPath("w1"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ stdout hello$/);
    expect(lines[1]).toContain("sk-[redacted]");
  });

  it("never throws on an unwritable path", () => {
    process.env.OCM_STATE_DIR = blockedDir();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => appendWorkerOutput("w", "stdout", "x")).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});

describe("readLogs", () => {
  it("returns nothing when no log exists", () => {
    expect(readLogs()).toEqual([]);
  });

  it("filters, skips corrupt lines and honours limit", () => {
    log("info", "a.one", { worker: "w1", manager: "m1", request_id: "r1" });
    log("error", "b.two", { worker: "w2" });
    appendFileSync(serverLogPath(), "not json\n\n");
    log("warn", "a.three", { worker: "w1" });
    expect(readLogs({ event: "a." })).toHaveLength(2);
    expect(readLogs({ level: "warn" }).map((e) => e.event)).toEqual(["b.two", "a.three"]);
    expect(readLogs({ worker: "w2" })).toHaveLength(1);
    expect(readLogs({ manager: "m1" })).toHaveLength(1);
    expect(readLogs({ request_id: "r1" })).toHaveLength(1);
    expect(readLogs({ since: "2999-01-01T00:00:00Z" })).toEqual([]);
    expect(readLogs({ limit: 1 }).map((e) => e.event)).toEqual(["a.three"]);
  });
});

describe("installCrashLogging", () => {
  it("logs uncaught exceptions then exits, and unhandled rejections", () => {
    const handlers: Record<string, (arg: unknown) => void> = {};
    const realOn = process.on.bind(process);
    vi.spyOn(process, "on").mockImplementation(((name: string, fn: (arg: unknown) => void) => {
      if (name === "uncaughtException" || name === "unhandledRejection") handlers[name] = fn;
      else realOn(name, fn);
      return process;
    }) as never);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    installCrashLogging();
    handlers.uncaughtException(new Error("dead"));
    handlers.unhandledRejection("why");
    expect(exit).toHaveBeenCalledWith(1);
    expect(readLogs().map((e) => e.event)).toEqual([
      "process.uncaught_exception",
      "process.unhandled_rejection",
    ]);
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLogs } from "../../../src/modules/ocm/log.js";
import { checkLaunchAllowed, readMemory } from "../../../src/modules/ocm/memory.js";

// Wrap readFileSync so tests can intercept the default /proc/meminfo read
// without touching special filesystems; everything else stays passthrough.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let dir: string;

function fixture(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocm-memory-"));
  process.env.OCM_STATE_DIR = dir;
  delete process.env.OCM_LOG_LEVEL;
  delete process.env.OCM_MIN_AVAILABLE_MB;
});

afterEach(() => {
  delete process.env.OCM_STATE_DIR;
  delete process.env.OCM_LOG_LEVEL;
  delete process.env.OCM_MIN_AVAILABLE_MB;
  vi.mocked(readFileSync).mockClear();
  rmSync(dir, { recursive: true, force: true });
});

describe("readMemory", () => {
  it("parses kB into floored MB", () => {
    const path = fixture(
      "meminfo",
      [
        "MemTotal:       32763013 kB",
        "MemFree:         1023456 kB",
        "MemAvailable:    1198123 kB",
        "Buffers:          204800 kB",
        "",
      ].join("\n"),
    );
    expect(readMemory(path)).toEqual({ totalMb: 31995, availableMb: 1170 });
  });

  it("throws naming the file when MemAvailable is missing", () => {
    const path = fixture("meminfo", "MemTotal:       32763013 kB\n");
    expect(() => readMemory(path)).toThrowError(
      expect.objectContaining({ message: expect.stringContaining(`${path}: no MemAvailable`) }),
    );
  });

  it("throws naming the file when it cannot be read", () => {
    const path = join(dir, "unreadable");
    mkdirSync(path);
    expect(() => readMemory(path)).toThrowError(
      expect.objectContaining({ message: expect.stringContaining(`could not read ${path}`) }),
    );
  });

  it("defaults MemTotal to 0 when the line is missing", () => {
    const path = fixture("meminfo", "MemAvailable:      2048 kB\n");
    expect(readMemory(path)).toEqual({ totalMb: 0, availableMb: 2 });
  });
});

describe("checkLaunchAllowed", () => {
  it("blocks below the 2048 MB default and logs warn with both numbers", () => {
    const result = checkLaunchAllowed({ info: { totalMb: 31995, availableMb: 1170 } });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(
      "available 1170 MB is below the 2048 MB minimum; close idle claude sessions or stray opencode processes",
    );
    const entry = readLogs({ level: "warn" }).find((e) => e.event === "memory.launch_blocked");
    expect(entry).toMatchObject({ availableMb: 1170, minAvailableMb: 2048 });
  });

  it("allows exactly at the boundary value and logs debug", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    const result = checkLaunchAllowed({ info: { totalMb: 32000, availableMb: 2048 } });
    expect(result).toEqual({ allowed: true, availableMb: 2048, minAvailableMb: 2048 });
    const entry = readLogs({ level: "debug" }).find((e) => e.event === "memory.launch_allowed");
    expect(entry).toMatchObject({ availableMb: 2048, minAvailableMb: 2048 });
  });

  it("honours a positive OCM_MIN_AVAILABLE_MB", () => {
    process.env.OCM_MIN_AVAILABLE_MB = "1024";
    const result = checkLaunchAllowed({ info: { totalMb: 32000, availableMb: 1170 } });
    expect(result.allowed).toBe(true);
    expect(result.minAvailableMb).toBe(1024);
  });

  it("falls back to 2048 on a non-positive or non-integer env value", () => {
    for (const raw of ["0", "-5", "abc", "2048.5"]) {
      process.env.OCM_MIN_AVAILABLE_MB = raw;
      const result = checkLaunchAllowed({ info: { totalMb: 32000, availableMb: 1500 } });
      expect(result).toMatchObject({ allowed: false, minAvailableMb: 2048 });
    }
  });

  it("fails open when memory cannot be read and logs warn", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("disk on fire");
    });
    const result = checkLaunchAllowed();
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("memory could not be read");
    expect(result.reason).toContain("disk on fire");
    const entry = readLogs({ level: "warn" }).find((e) => e.event === "memory.read_failed");
    expect(String(entry?.message)).toContain("disk on fire");
  });

  it("reads the default meminfo path when no info is passed", () => {
    vi.mocked(readFileSync).mockImplementationOnce(
      () => "MemTotal:       4096 kB\nMemAvailable:    4096 kB\n",
    );
    const result = checkLaunchAllowed({ minAvailableMb: 2 });
    expect(result).toEqual({ allowed: true, availableMb: 4, minAvailableMb: 2 });
  });
});

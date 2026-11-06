import { readFileSync } from "node:fs";
import { createLogger, errorFields } from "./log.js";

/** RAM snapshot in MB as parsed from a meminfo file. */
export interface MemoryInfo {
  totalMb: number;
  availableMb: number;
}

interface LaunchCheck {
  allowed: boolean;
  availableMb: number;
  minAvailableMb: number;
  reason?: string;
}

const log = createLogger({ module: "memory" });

/** Free-RAM floor for a launch: OCM_MIN_AVAILABLE_MB if a positive integer, else 2048. */
function minAvailableMb(): number {
  const parsed = Number(process.env.OCM_MIN_AVAILABLE_MB);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2048;
}

/**
 * Parse MemTotal/MemAvailable (kB) out of a meminfo file, floored to MB.
 * The path parameter exists only so tests can use a fixture file.
 */
export function readMemory(path: string = "/proc/meminfo"): MemoryInfo {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`could not read ${path}: ${errorFields(error).message}`);
  }
  const kb = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s*kB/.exec(line);
    if (match) kb.set(match[1], Number(match[2]));
  }
  const available = kb.get("MemAvailable");
  if (available === undefined) throw new Error(`could not read ${path}: no MemAvailable line`);
  return {
    totalMb: Math.floor((kb.get("MemTotal") ?? 0) / 1024),
    availableMb: Math.floor(available / 1024),
  };
}

/**
 * Decide whether the host has room for another worker. Fail-open: when memory
 * itself cannot be read the launch is allowed and the failure logged at warn.
 */
export function checkLaunchAllowed(
  opts: { minAvailableMb?: number; info?: MemoryInfo } = {},
): LaunchCheck {
  const min = opts.minAvailableMb ?? minAvailableMb();
  let info = opts.info;
  if (!info) {
    try {
      info = readMemory();
    } catch (error) {
      log.warn("memory.read_failed", errorFields(error));
      return {
        allowed: true,
        availableMb: 0,
        minAvailableMb: min,
        reason: `memory could not be read (${errorFields(error).message}); allowing launch`,
      };
    }
  }
  if (info.availableMb >= min) {
    log.debug("memory.launch_allowed", { availableMb: info.availableMb, minAvailableMb: min });
    return { allowed: true, availableMb: info.availableMb, minAvailableMb: min };
  }
  const reason = `available ${info.availableMb} MB is below the ${min} MB minimum; close idle claude sessions or stray opencode processes`;
  log.warn("memory.launch_blocked", { availableMb: info.availableMb, minAvailableMb: min, reason });
  return { allowed: false, availableMb: info.availableMb, minAvailableMb: min, reason };
}

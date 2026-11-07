import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../../src/modules/ocm/version.js";

describe("VERSION", () => {
  it("matches package.json so health, healthz and the MCP handshake agree", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

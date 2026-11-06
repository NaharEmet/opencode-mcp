import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DEFAULT_PORT,
  ensureToken,
  type HttpServerOptions,
  main,
  portFrom,
  type RunningServer,
  serverInstructions,
  startHttpServer,
} from "../../../src/modules/ocm/http-server.js";
import { readLogs } from "../../../src/modules/ocm/log.js";

// tool.js belongs to T8a and may not exist yet; mock both the virtualized id
// Vite produces pre-merge and the resolved id that wins once it lands.
vi.mock("/src/modules/ocm/tool.js", async () => {
  const { z: zod } = await import("zod");
  return {
    actionShape: { action: zod.string(), manager: zod.string() },
    handleAction: async (input: unknown) => ({ ok: true, input }),
    tick: async () => {},
  };
});
vi.mock("../../../src/modules/ocm/tool.js", async () => {
  const { z: zod } = await import("zod");
  return {
    actionShape: { action: zod.string(), manager: zod.string() },
    handleAction: async (input: unknown) => ({ ok: true, input }),
    tick: async () => {},
  };
});

// Wrap the server transport so tests can force failures inside route() at both
// header stages: POST ?crash throws before any response is written (500) and
// GET ?crash throws after the SSE headers (connection destroyed).
vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", async (importActual) => {
  const actual =
    await importActual<typeof import("@modelcontextprotocol/sdk/server/streamableHttp.js")>();
  class CrashTransport extends actual.StreamableHTTPServerTransport {
    override async handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) {
      if (!new URL(req.url ?? "/", "http://localhost").searchParams.has("crash")) {
        return super.handleRequest(req, res, parsedBody);
      }
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: partial\n\n");
      }
      throw new Error("simulated crash");
    }
  }
  return { ...actual, StreamableHTTPServerTransport: CrashTransport };
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const shape = { action: z.string(), manager: z.string() };
let dir: string;
let homeBackup: string | undefined;
let running: RunningServer | undefined;

function opts(over: Partial<HttpServerOptions> = {}): HttpServerOptions {
  return {
    port: 0,
    tokenPath: join(dir, "token"),
    actionShape: shape,
    handleAction: async (input: unknown) => ({ ok: true, echo: input }),
    tick: async () => {},
    version: "test-1",
    instructions: "test instructions",
    ...over,
  };
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(`${running?.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token()}` } },
  });
  const client = new Client({ name: "ocm-http-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function payload(result: unknown): unknown {
  return JSON.parse((result as { content: [{ text: string }] }).content[0].text);
}

function token(): string {
  return readFileSync(join(dir, "token"), "utf8");
}

function entry(event: string): Record<string, unknown> | undefined {
  return readLogs().find((e) => e.event === event);
}

/**
 * Registers a fake process.on so crash and signal handlers are captured
 * instead of installed, unrelated events fall through to the real handler.
 */
function captureHandlers(): Record<string, (arg?: unknown) => void> {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const realOn = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation(((
    event: string,
    listener: (arg?: unknown) => void,
  ) => {
    if (["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"].includes(event)) {
      handlers[event] = listener;
    } else {
      realOn(event as NodeJS.Signals, listener as NodeJS.SignalsListener);
    }
    return process;
  }) as never);
  return handlers;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocm-http-"));
  process.env.OCM_STATE_DIR = dir;
  homeBackup = process.env.HOME;
  process.env.HOME = dir; // keep os.homedir() fallbacks inside the temp dir
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  process.env.HOME = homeBackup;
  delete process.env.OCM_STATE_DIR;
  delete process.env.XDG_STATE_HOME;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("serverInstructions", () => {
  it("stays short and tells the agent how to use worker", () => {
    const text = serverInstructions();
    expect(text.length).toBeLessThan(1500);
    for (const need of ["manager", "WARNING", "all:true", "restart", "pick", "budget", "verdict"]) {
      expect(text).toContain(need);
    }
  });
});

describe("ensureToken", () => {
  it("creates a 0600 token in a 0700 directory and reuses it", () => {
    const path = join(dir, "nested", "token");
    const first = ensureToken(path);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(ensureToken(path)).toBe(first);
  });

  it("returns trimmed existing contents unchanged", () => {
    const path = join(dir, "seeded");
    writeFileSync(path, "  a-hand-set-token-1234\n", { mode: 0o600 });
    expect(ensureToken(path)).toBe("a-hand-set-token-1234");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("never accepts an empty or tiny token file as the credential", () => {
    for (const [name, body] of [
      ["empty", ""],
      ["blank", "  \n"],
      ["tiny", "abc"],
    ] as const) {
      const path = join(dir, name);
      writeFileSync(path, body, { mode: 0o600 });
      const token = ensureToken(path);
      expect(token).toMatch(/^[0-9a-f]{64}$/u);
      expect(readFileSync(path, "utf8")).toBe(token);
    }
  });

  it("rejects `Bearer ` with nothing after it even if the token file was empty", async () => {
    const tokenPath = join(dir, "emptied");
    writeFileSync(tokenPath, "", { mode: 0o600 });
    const server = await startHttpServer({
      port: 0,
      tokenPath,
      actionShape: { action: z.string() },
      handleAction: async () => ({ ok: true }),
      tick: async () => {},
      version: "t",
      instructions: "t",
    });
    try {
      const res = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer ", "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("startHttpServer", () => {
  it("exposes exactly one worker tool", async () => {
    running = await startHttpServer(opts());
    const { client } = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["worker"]);
    expect(tools.tools[0].title).toBe("Worker server");
    expect(tools.tools[0].description).toBeTruthy();
  });

  it("returns the stub result as JSON text", async () => {
    running = await startHttpServer(opts());
    const { client } = await connect();
    const result = await client.callTool({
      name: "worker",
      arguments: { action: "ps", manager: "m1" },
    });
    expect(result.isError).toBeFalsy();
    expect(payload(result)).toEqual({
      ok: true,
      echo: { action: "ps", manager: "m1" },
    });
  });

  it("reports an ok:false stub as a tool error", async () => {
    running = await startHttpServer(opts({ handleAction: async () => ({ ok: false }) }));
    const { client } = await connect();
    const result = await client.callTool({
      name: "worker",
      arguments: { action: "run", manager: "m1" },
    });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toBe("action failed");
  });

  it("keeps a stub's own error text", async () => {
    running = await startHttpServer(
      opts({ handleAction: async () => ({ ok: false, error: "limited until 12:30Z" }) }),
    );
    const { client } = await connect();
    const result = await client.callTool({
      name: "worker",
      arguments: { action: "run", manager: "m1" },
    });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toBe("limited until 12:30Z");
  });

  it("reports a throwing stub as a tool error", async () => {
    running = await startHttpServer(
      opts({
        handleAction: () => {
          throw new Error("boom");
        },
      }),
    );
    const { client } = await connect();
    const result = await client.callTool({
      name: "worker",
      arguments: { action: "run", manager: "m1" },
    });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toBe("boom");
    expect(entry("tool.call_failed")).toBeDefined();
  });

  it("serves two clients in separate sessions", async () => {
    running = await startHttpServer(opts());
    const one = await connect();
    const two = await connect();
    await one.client.listTools();
    await two.client.listTools();
    expect(one.transport.sessionId).toBeDefined();
    expect(two.transport.sessionId).toBeDefined();
    expect(one.transport.sessionId).not.toBe(two.transport.sessionId);
    expect(readLogs().filter((e) => e.event === "session.created")).toHaveLength(2);
    // Removing the newer session walks the map past an unrelated entry first.
    await two.transport.terminateSession();
    await two.client.close();
    expect(readLogs().filter((e) => e.event === "session.closed")).toHaveLength(1);
    await one.client.close();
  });

  it("rejects missing, malformed and wrong bearer tokens without echoing them", async () => {
    running = await startHttpServer(opts());
    const url = `${running.url}/mcp`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    for (const headers of [
      {},
      { authorization: "Basic abc" },
      { authorization: `Bearer ${"f".repeat(64)}` },
      { authorization: `Bearer short` },
    ]) {
      const res = await fetch(url, { method: "POST", headers, body });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    const logged = entry("server.unauthorized");
    expect(logged?.remote).toBeTruthy();
    expect(logged?.path).toBe("/mcp");
    expect(logged?.authorization).toBeUndefined();
    expect(JSON.stringify(logged)).not.toContain(token());
  });

  it("answers healthz with no auth", async () => {
    running = await startHttpServer(opts());
    const res = await fetch(`${running.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "test-1" });
  });

  it("rejects unknown paths and unsupported methods", async () => {
    running = await startHttpServer(opts());
    const auth = { authorization: `Bearer ${token()}` };
    expect((await fetch(`${running.url}/other`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${running.url}/healthz`, { method: "POST", headers: auth })).status).toBe(
      404,
    );
    const res = await fetch(`${running.url}/mcp`, { method: "PATCH", headers: auth });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method not allowed" });
  });

  it("answers unknown session ids with a JSON-RPC 404", async () => {
    running = await startHttpServer(opts());
    const res = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "mcp-session-id": "ghost" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "session not found" },
    });
  });

  it("rejects non-initialize posts without a session id", async () => {
    running = await startHttpServer(opts());
    const res = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing mcp-session-id" });
  });

  it("returns 413 for oversized bodies and 400 for invalid JSON", async () => {
    running = await startHttpServer(opts());
    const auth = { authorization: `Bearer ${token()}` };
    const huge = `{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${"x".repeat(3 * 1024 * 1024)}"}`;
    expect(
      (await fetch(`${running.url}/mcp`, { method: "POST", headers: auth, body: huge })).status,
    ).toBe(413);
    const bad = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: auth,
      body: "not json",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid JSON" });
  });

  it("removes sessions on DELETE", async () => {
    running = await startHttpServer(opts());
    const { client, transport } = await connect();
    await client.listTools();
    const sessionId = transport.sessionId as string;
    await transport.terminateSession();
    await client.close();
    const res = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping", params: {} }),
    });
    expect(res.status).toBe(404);
    expect(entry("session.closed")).toMatchObject({ sessionId });
  });

  it("fires the tick and survives a throwing tick", async () => {
    let ticks = 0;
    running = await startHttpServer(opts({ tickMs: 10, tick: async () => void ticks++ }));
    await sleep(80);
    expect(ticks).toBeGreaterThanOrEqual(1);

    let runs = 0;
    const thrower = await startHttpServer(
      opts({
        tickMs: 10,
        handleAction: async () => ({ ok: true }),
        tick: async () => {
          runs++;
          throw new Error("tick boom");
        },
      }),
    );
    await sleep(80);
    expect(runs).toBeGreaterThanOrEqual(1);
    const res = await fetch(`${thrower.url}/healthz`);
    expect(res.status).toBe(200);
    expect(entry("server.tick_failed")).toBeDefined();
    await thrower.close();
  });

  it("answers 500 when a route crashes before headers", async () => {
    running = await startHttpServer(opts());
    const res = await fetch(`${running.url}/mcp?crash=1`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    expect(entry("server.request_failed")).toBeDefined();
  });

  it("destroys a response that already streamed when a route crashes", async () => {
    running = await startHttpServer(opts());
    const { client, transport } = await connect();
    await client.listTools();
    await fetch(`${running.url}/mcp?crash=1`, {
      method: "GET",
      headers: { authorization: `Bearer ${token()}`, "mcp-session-id": transport.sessionId },
      signal: AbortSignal.timeout(500),
    }).catch(() => undefined);
    await sleep(50);
    expect(entry("server.request_failed")).toBeDefined();
    await client.close();
  });

  it("is safe to close twice and removes sessions on close", async () => {
    running = await startHttpServer(opts());
    const { client } = await connect();
    await client.listTools();
    await running.close();
    await running.close();
    expect(readLogs().filter((e) => e.event === "session.closed")).toHaveLength(1);
  });

  it("routes GET without or with unknown session id to the right status", async () => {
    running = await startHttpServer(opts());
    const auth = { authorization: `Bearer ${token()}` };
    expect((await fetch(`${running.url}/mcp`, { headers: auth })).status).toBe(400);
    expect(
      (await fetch(`${running.url}/mcp`, { headers: { ...auth, "mcp-session-id": "ghost" } }))
        .status,
    ).toBe(404);
  });
});

describe("main", () => {
  it("defaults the port to 7357 unless OCM_PORT is set", () => {
    expect(portFrom({})).toBe(DEFAULT_PORT);
    expect(portFrom({ OCM_PORT: "8123" })).toBe(8123);
  });

  it("uses process.env defaults for port, host and token path", async () => {
    const handlers = captureHandlers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    process.env.OCM_PORT = "0";
    delete process.env.OCM_HOST;
    delete process.env.OCM_TOKEN_PATH;
    running = await main();
    const tokenPath = join(dir, ".config", "opencode-worker-server", "token");
    expect(DEFAULT_PORT).toBe(7357);
    expect(running.url).toBe(`http://127.0.0.1:${running.port}`);
    expect(existsSync(tokenPath)).toBe(true);
    const started = entry("server.started");
    expect(started).toMatchObject({ tokenPath: "[redacted]", url: running.url });
    expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
    handlers.SIGTERM?.(undefined);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(entry("server.stopped")).toMatchObject({ signal: "SIGTERM" });
  });

  it("honors OCM_PORT/OCM_HOST/OCM_TOKEN_PATH and closes on SIGINT", async () => {
    const handlers = captureHandlers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    running = await main({
      OCM_PORT: "0",
      OCM_HOST: "127.0.0.1",
      OCM_TOKEN_PATH: join(dir, "tok2"),
    });
    expect(existsSync(join(dir, "tok2"))).toBe(true);
    handlers.SIGINT?.(undefined);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(entry("server.stopped")).toMatchObject({ signal: "SIGINT" });
  });
});

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { createLogger, errorFields, installCrashLogging } from "./log.js";

const logger = createLogger({ module: "ocm.http-server" });
const MAX_BODY_BYTES = 1024 * 1024;
const VERSION = "1.3.1";
const BEARER_PREFIX = "Bearer ";
const MIN_TOKEN_CHARS = 16;
const TOOL_DESCRIPTION =
  "Dispatch a worker action and always pass your manager name; covers run, ps, events, restart, pick, budget, verdict and logs.";

/** Port the server listens on unless OCM_PORT overrides it. */
export const DEFAULT_PORT = 7357;

/** Listening port from OCM_PORT, else the default. */
export function portFrom(env: NodeJS.ProcessEnv): number {
  return env.OCM_PORT ? Number.parseInt(env.OCM_PORT, 10) : DEFAULT_PORT;
}

export interface HttpServerOptions {
  port: number;
  host?: string;
  tokenPath: string;
  actionShape: z.ZodRawShape;
  /* biome-ignore lint/suspicious/noExplicitAny: actionShape validation defines the payload type */
  handleAction: (input: any) => Promise<{ ok: boolean; [k: string]: unknown }>;
  tick: () => Promise<void>;
  tickMs?: number;
  version: string;
  instructions: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Read the bearer token from path; missing tokens are created as a 32-byte hex string (0600 file). */
export function ensureToken(path: string): string {
  // an empty or tiny token file must never become the credential: "Bearer " would match it
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= MIN_TOKEN_CHARS) return existing;
    logger.warn("server.token_regenerated", { path, reason: "existing token too short" });
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

/** Permanent instruction block the server advertises to clients (the init payload `instructions` field). */
export function serverInstructions(): string {
  return [
    `You have one tool: "worker". Always pass your manager name in "manager"; it scopes what you own and see.`,
    `- run: launch or continue a worker. If the target model is currently limited, the tool returns a WARNING and launches nothing; repeat the identical run call within 10 minutes to launch anyway.`,
    `- ps: list workers; defaults to your own workers, pass all:true to see everyone's. It also reproduces the WARNING from a recent run on a limited model.`,
    `- events: worker stdout/stderr event history; same default and all:true as ps.`,
    `- restart: resume a stopped worker's same ticket in the same directory on the next unblocked model.`,
    `- pick: choose a model (always "provider/model"). budget: show remaining quota and limits per model.`,
    `- verdict: record a finished worker's pass/fail and strike counts.`,
    `- logs: read recent server log events.`,
    `Never claim a worker launched unless an action reported ok:true; a launch is only confirmed by watching events and ps.`,
  ].join("\n");
}

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** 404 in JSON-RPC shape, as a non-routable JSON-RPC request would expect. */
function rpcError(res: ServerResponse, status: number, message: string): void {
  respond(res, status, { jsonrpc: "2.0", id: null, error: { code: -32000, message } });
}

/** Constant-time bearer check; unequal lengths never reach timingSafeEqual. */
function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) return false;
  const given = Buffer.from(header.slice(BEARER_PREFIX.length), "utf8");
  const expected = Buffer.from(token, "utf8");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/**
 * Parse a JSON request body, capping at MAX_BODY_BYTES. Oversized bodies are
 * drained and answered 413, malformed JSON is 400; errors resolve (never
 * reject) so every route continues to a response.
 */
function readBody(req: IncomingMessage): Promise<{ status: number; body?: unknown }> {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (result: { status: number; body?: unknown }) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return; // keep draining so the client's write completes cleanly
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }
      tooLarge = true;
      chunks.length = 0;
    });
    req.on("end", () => {
      if (tooLarge) {
        finish({ status: 413 });
        return;
      }
      try {
        finish({ status: 200, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        finish({ status: 400 });
      }
    });
    // "close" always fires; it also seals a request aborted before end.
    req.on("close", () => finish({ status: 400 }));
  });
}

/**
 * Run the MCP server on streamable HTTP behind a bearer token: one `worker`
 * tool backed by opts, one transport/session per initialize call, and a
 * periodic opts.tick(). Returns real port and a close() awaiting full shutdown
 * (safe to call twice).
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<RunningServer> {
  const token = ensureToken(opts.tokenPath);
  const sessions = new Map<string, SessionEntry>();
  let closed = false;
  const timer = setInterval(() => {
    opts.tick().catch((error) => logger.error("server.tick_failed", errorFields(error)));
  }, opts.tickMs ?? 5000);
  timer.unref();

  async function startSession(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const server = new McpServer(
      { name: "opencode-worker-server", version: opts.version },
      { instructions: opts.instructions },
    );
    let sessionId: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (initialized) => {
        sessionId = initialized;
        sessions.set(initialized, { server, transport });
        logger.info("session.created", { sessionId: initialized });
      },
    });
    server.registerTool(
      "worker",
      { title: "Worker server", description: TOOL_DESCRIPTION, inputSchema: opts.actionShape },
      async (args) => {
        try {
          const result = await opts.handleAction(args);
          if (result.ok) return jsonResult(result);
          return jsonError({ ...result, ok: false, error: result.error ?? "action failed" });
        } catch (error) {
          logger.error("tool.call_failed", errorFields(error));
          return jsonError({ ok: false, error: errorFields(error).message });
        }
      },
    );
    await server.connect(transport);
    // The protocol registers its own onclose during connect; chain ours to it
    // so session removal also runs on close() shutting transports down directly.
    const protocolOnClose = transport.onclose;
    transport.onclose = () => {
      protocolOnClose?.();
      for (const [existing, entry] of sessions) {
        if (entry.transport === transport) sessions.delete(existing);
      }
      logger.info("session.closed", { sessionId });
    };
    await transport.handleRequest(req, res, body);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url as string, "http://localhost").pathname;
    const start = Date.now();
    res.on("finish", () => {
      logger.debug("server.request", {
        method: req.method,
        path,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    if (path === "/healthz" && req.method === "GET") {
      respond(res, 200, { ok: true, version: opts.version });
      return;
    }
    if (path !== "/mcp") {
      respond(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      respond(res, 405, { error: "method not allowed" });
      return;
    }
    if (!isAuthorized(req, token)) {
      logger.warn("server.unauthorized", { remote: req.socket.remoteAddress, path });
      respond(res, 401, { error: "unauthorized" });
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const known = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (req.method === "POST") {
      const { status, body } = await readBody(req);
      if (status !== 200) {
        respond(res, status, { error: status === 413 ? "payload too large" : "invalid JSON" });
        return;
      }
      if (typeof sessionId === "string") {
        if (!known) {
          rpcError(res, 404, "session not found");
          return;
        }
        await known.transport.handleRequest(req, res, body);
        return;
      }
      const message = body as { method?: string };
      if (message.method === "initialize") {
        await startSession(req, res, body);
        return;
      }
      respond(res, 400, { error: "missing mcp-session-id" });
      return;
    }
    if (!known) {
      rpcError(res, typeof sessionId === "string" ? 404 : 400, "session not found");
      return;
    }
    await known.transport.handleRequest(req, res);
  }

  const onRequest: RequestListener = (req, res) => {
    route(req, res).catch((error) => {
      logger.error("server.request_failed", errorFields(error));
      if (res.headersSent) res.destroy();
      else respond(res, 500, { error: "internal error" });
    });
  };
  const host = opts.host ?? "127.0.0.1";
  const httpServer = createServer(onRequest);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, host, resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;
  logger.info("server.listening", { host, port });
  return {
    url: `http://${host}:${port}`,
    port,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      const entries = [...sessions.values()];
      sessions.clear();
      for (const entry of entries) await entry.transport.close();
      // closeAllConnections ends keep-alive sockets so close() cannot stall behind them.
      httpServer.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      logger.info("server.closed", { host, port });
    },
  };
}

/** Wire real actions from ./tool.js dynamically so this module stays tool-free. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<RunningServer> {
  const toolPath = "./tool.js";
  const { actionShape, handleAction, tick } = (await import(toolPath)) as {
    actionShape: z.ZodRawShape;
    handleAction: HttpServerOptions["handleAction"];
    tick: () => Promise<void>;
  };
  const tokenPath =
    env.OCM_TOKEN_PATH ?? join(homedir(), ".config", "opencode-worker-server", "token");
  const running = await startHttpServer({
    port: portFrom(env),
    host: env.OCM_HOST,
    tokenPath,
    actionShape,
    handleAction,
    tick,
    version: VERSION,
    instructions: serverInstructions(),
  });
  installCrashLogging();
  logger.info("server.started", { url: running.url, tokenPath });
  const stop = (signal: string) => {
    void running.close().then(() => {
      logger.info("server.stopped", { signal });
      process.exit(0);
    });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  return running;
}

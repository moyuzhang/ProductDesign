import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { registerApi } from "./api.js";
import { Store } from "./db.js";
import { syncManagedProjectStorage } from "./projectFiles.js";
import { createMcpServer } from "../mcp/index.js";
import { CodexHarness } from "./agentHarness.js";
import { AgentUiEventBus } from "./agentUiEvents.js";
import { reconcilePlanDeliveryProjections } from "./planLifecycle.js";

export interface BuildOptions {
  dbPath?: string;
  dataDir?: string;
  logger?: boolean;
  trustedInternalApi?: boolean;
}

function toWebHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const h = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => h.append(key, v));
    else h.set(key, value);
  }
  return h;
}

async function handleMcpRequest(handler: McpHttpHandler, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = `http://${request.headers.host ?? "127.0.0.1:4310"}${request.url}`;
  const init: RequestInit = {
    method: request.method,
    headers: toWebHeaders(request.headers as Record<string, string | string[] | undefined>),
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body === undefined ? "" : JSON.stringify(request.body as unknown);
  }
  const webResponse = await handler.fetch(new Request(url, init));
  const isSubscriptionStream = request.method === "GET" && webResponse.body && webResponse.headers.get("content-type")?.startsWith("text/event-stream");
  if (isSubscriptionStream) {
    reply.hijack();
    reply.raw.statusCode = webResponse.status;
    webResponse.headers.forEach((value, key) => reply.raw.setHeader(key, value));
    Readable.fromWeb(webResponse.body as unknown as ReadableStream<Uint8Array>).pipe(reply.raw);
    return;
  }
  const body = webResponse.body ? Buffer.from(await webResponse.arrayBuffer()) : undefined;
  reply.code(webResponse.status);
  webResponse.headers.forEach((value, key) => reply.header(key, value));
  reply.send(body);
}

export function buildApp(options: BuildOptions = {}) {
  const dbPath = options.dbPath ?? process.env.PCS_DB ?? resolve("data/control-surface.db");
  const dataDir = options.dataDir ?? resolve("data");
  const store = new Store(dbPath, dataDir);
  const agentUiEvents = new AgentUiEventBus();
  let harness: CodexHarness;
  harness = new CodexHarness(store, dataDir, () => createMcpServer({ store, dbPath, dataDir, harness, trustedInternal: true }), agentUiEvents);
  syncManagedProjectStorage(store, dataDir);
  reconcilePlanDeliveryProjections(store);
  const app = Fastify({ logger: options.logger ?? false });
  registerApi(app, { store, dataDir, harness, agentUiEvents, trustedInternal: options.trustedInternalApi });

  const mcpHandler = createMcpHandler(() => createMcpServer({ store, dbPath, dataDir, harness }));
  app.all("/mcp", async (request, reply) => {
    try {
      await handleMcpRequest(mcpHandler, request, reply);
    } catch (error) {
      request.log.error({ err: error, method: request.method, url: request.url }, "MCP request failed");
      if (!reply.sent) reply.code(500).send({ message: "MCP 处理失败" });
    }
  });

  const webRoot = resolve("dist/web");
  if (existsSync(webRoot)) {
    app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      if (request.method === "GET" && existsSync(resolve(webRoot, "index.html"))) {
        return reply.sendFile("index.html");
      }
      reply.code(404).send({ message: "Not Found" });
    });
  }

  app.addHook("onClose", async () => {
    harness.close();
    store.close();
  });
  return app;
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const port = Number(process.env.PORT ?? "4310");
  const host = process.env.HOST ?? "127.0.0.1";
  void (async () => {
    try {
      const app = buildApp({ logger: true });
      await app.listen({ port, host });
      console.log(`[pcs] API 已启动: http://${host}:${port} (数据库: data/control-surface.db)`);
    } catch (error) {
      console.error("[pcs] 启动失败:", error);
      process.exit(1);
    }
  })();
}

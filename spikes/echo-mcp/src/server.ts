import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.JW_PORT ?? 8080);

// Stateless: a fresh server + transport per request, no session id (V11).
function buildServer(): McpServer {
  const server = new McpServer({ name: "jobwatch-echo", version: "0.0.0" });
  server.registerTool(
    "echo",
    {
      title: "Echo (read-only)",
      description: "Returns the given text. Read-only, no side effects.",
      inputSchema: { text: z.string().max(200) },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  return server;
}

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless mode: no server-initiated stream, no session teardown.
for (const method of ["get", "delete"] as const) {
  app[method]("/mcp", (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });
}

app.listen(PORT, () => console.log(`echo MCP on :${PORT}`));

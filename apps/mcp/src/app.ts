import { type Config, type EngineLogger } from '@jobwatch/core';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { requireLoopbackHost, requireSharedSecret } from './auth';
import { buildMcpServer, type McpDeps } from './mcp';

export interface AppDeps extends McpDeps {
  config: Pick<Config, 'auth' | 'baseUrl' | 'frontSharedSecret'>;
  logger: EngineLogger;
}

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * The HTTP surface of the router: `/healthz` (open) and `/mcp` (stateless Streamable HTTP).
 * Nothing else is served: unknown paths are 404, and `/metrics` lives on a separate listener (`metrics-server.ts`).
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // Health check: no authentication, no data. Used by the Docker healthcheck and by Nginx.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  const guards: ((req: Request, res: Response, next: NextFunction) => void)[] = [];
  if (deps.config.auth === 'none') guards.push(requireLoopbackHost([new URL(deps.config.baseUrl).hostname]));
  if (deps.config.auth === 'front' && deps.config.frontSharedSecret !== undefined)
    guards.push(requireSharedSecret(deps.config.frontSharedSecret));

  // Express 5 rejects app.use() with no middleware, and front mode without a shared secret has no guard (documented default).
  if (guards.length > 0) app.use('/mcp', ...guards);
  app.use('/mcp', express.json({ limit: '256kb' }));

  app.post('/mcp', async (req, res) => {
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      deps.logger.error({ err: error }, 'mcp_request_failed');
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Internal error'));
    }
  });

  // Stateless mode has no server-initiated stream and no session to end.
  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', (_req, res) => {
      res.status(405).set('Allow', 'POST').json(jsonRpcError(-32000, 'Method not allowed'));
    });
  }

  // Malformed JSON, oversized bodies and anything else Express raises: a JSON-RPC error, never a stack trace.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number }).status;
    if (status === 413) return void res.status(413).json(jsonRpcError(-32600, 'Request too large'));
    if (status !== undefined && status >= 400 && status < 500) return void res.status(400).json(jsonRpcError(-32700, 'Parse error'));
    deps.logger.error({ err: error }, 'http_error');
    return void res.status(500).json(jsonRpcError(-32603, 'Internal error'));
  });

  return app;
}

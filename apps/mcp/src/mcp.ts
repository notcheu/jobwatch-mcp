import { callTool, listTools, UnknownToolError, type CallDeps, type Metrics } from '@jobwatch/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

export interface McpDeps extends CallDeps {
  metrics: Metrics | undefined;
  version: string;
}

/**
 * One MCP server per request (stateless: no session id, nothing remembered between requests).
 * `tools/list` is answered from the registry, which is pure data: no container starts, no handler runs.
 */
export function buildMcpServer(deps: McpDeps): Server {
  const server = new Server({ name: 'jobwatch', version: deps.version }, { capabilities: { tools: { listChanged: false } } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools(deps.registry) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { result, outcome } = await callTool(deps, request.params.name, request.params.arguments);
      deps.metrics?.record(outcome);
      return result;
    } catch (error) {
      // An unregistered tool is a protocol error (the model asked for something that does not exist), not a tool failure.
      if (error instanceof UnknownToolError) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${error.toolName}`);
      throw error;
    }
  });

  return server;
}

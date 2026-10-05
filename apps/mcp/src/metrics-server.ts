import { createServer, type Server } from 'node:http';
import type { Metrics } from '@jobwatch/core';

/**
 * Prometheus scrape endpoint on its OWN listener (METRICS_PORT), never on the MCP port, so it can never be reached
 * through the OAuth front or Nginx (docs/plans/03-router-spec.md). Serves GET /metrics and nothing else.
 */
export function createMetricsServer(metrics: Metrics): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      metrics.render().then(
        (text) => {
          res.writeHead(200, { 'Content-Type': metrics.contentType }).end(text);
        },
        () => {
          res.writeHead(500).end('metrics unavailable');
        },
      );
      return;
    }
    res.writeHead(404).end('not found');
  });
}

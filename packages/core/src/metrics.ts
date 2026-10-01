import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { ToolOutcome } from './call';

export interface Metrics {
  /** Count and time one finished tool call. */
  record(outcome: ToolOutcome): void;
  setEnabledAdapters(count: number): void;
  /** Prometheus text exposition format. */
  render(): Promise<string>;
  readonly contentType: string;
}

/**
 * Prometheus metrics (03-router-spec.md, "Health and ops endpoints"). Labels are low-cardinality on purpose: tool,
 * platform and result code only; never arguments, URLs or ids. Served on a separate listener, never on the MCP port.
 */
export function createMetrics(info: { version: string }): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const calls = new Counter({
    name: 'jw_tool_calls_total',
    help: 'Tool calls by tool, platform and result.',
    labelNames: ['tool', 'platform', 'result'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'jw_tool_duration_seconds',
    help: 'Tool call duration in seconds.',
    labelNames: ['tool'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
    registers: [registry],
  });
  const enabled = new Gauge({ name: 'jw_enabled_adapters', help: 'Number of enabled adapters.', registers: [registry] });
  new Gauge({ name: 'jw_build_info', help: 'Build information.', labelNames: ['version'], registers: [registry] })
    .labels(info.version)
    .set(1);

  return {
    record: (outcome) => {
      calls.labels(outcome.tool, outcome.platform, outcome.code).inc();
      duration.labels(outcome.tool).observe(outcome.durationMs / 1000);
    },
    setEnabledAdapters: (count) => enabled.set(count),
    render: () => registry.metrics(),
    contentType: registry.contentType,
  };
}

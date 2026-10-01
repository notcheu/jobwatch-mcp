import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { ToolOutcome } from './call';
import type { RuntimeEvent } from './runtime/manager';

export interface Metrics {
  /** Count and time one finished tool call. */
  record(outcome: ToolOutcome): void;
  setEnabledAdapters(count: number): void;
  /** Feed one runtime lifecycle event (state, cold start, memory, stop, queue wait). */
  recordRuntime(event: RuntimeEvent): void;
  /** Reflect a circuit breaker: pass the reason when it opens, undefined when it closes. */
  setBreaker(platform: string, reason: 'needs_login' | 'checkpoint' | undefined): void;
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
  const runtimeState = new Gauge({
    name: 'jw_runtime_state',
    help: 'Browser runtime state per platform (1 = current state).',
    labelNames: ['platform', 'state'],
    registers: [registry],
  });
  const coldStarts = new Counter({
    name: 'jw_runtime_cold_starts_total',
    help: 'Browser cold starts.',
    labelNames: ['platform'],
    registers: [registry],
  });
  const coldStart = new Histogram({
    name: 'jw_runtime_cold_start_seconds',
    help: 'Time to start a browser runtime.',
    buckets: [1, 2, 5, 10, 20, 30],
    registers: [registry],
  });
  const stops = new Counter({
    name: 'jw_runtime_stops_total',
    help: 'Browser runtime stops by reason.',
    labelNames: ['platform', 'reason'],
    registers: [registry],
  });
  const rss = new Gauge({
    name: 'jw_runtime_rss_bytes',
    help: 'Last working-set reading of the running browser.',
    labelNames: ['platform'],
    registers: [registry],
  });
  const queueWait = new Histogram({
    name: 'jw_queue_wait_seconds',
    help: 'Time a call waited for the browser.',
    buckets: [0, 0.5, 1, 5, 15, 30, 60],
    registers: [registry],
  });
  const breaker = new Gauge({
    name: 'jw_breaker_open',
    help: 'Circuit breaker state per platform (1 = open).',
    labelNames: ['platform', 'reason'],
    registers: [registry],
  });
  new Gauge({ name: 'jw_build_info', help: 'Build information.', labelNames: ['version'], registers: [registry] })
    .labels(info.version)
    .set(1);

  return {
    record: (outcome) => {
      calls.labels(outcome.tool, outcome.platform, outcome.code).inc();
      duration.labels(outcome.tool).observe(outcome.durationMs / 1000);
    },
    recordRuntime: (event) => {
      switch (event.type) {
        case 'state':
          for (const name of ['cold', 'starting', 'busy', 'idle_grace', 'stopping']) runtimeState.remove(event.platform, name);
          if (event.state !== 'cold') runtimeState.labels(event.platform, event.state).set(1);
          if (event.state === 'cold') rss.remove(event.platform);
          break;
        case 'cold_start':
          coldStarts.labels(event.platform).inc();
          coldStart.observe(event.ms / 1000);
          break;
        case 'memory':
          rss.labels(event.platform).set(event.bytes);
          break;
        case 'stopped':
          stops.labels(event.platform, event.reason).inc();
          break;
        case 'queue_wait':
          queueWait.observe(event.ms / 1000);
          break;
      }
    },
    setEnabledAdapters: (count) => enabled.set(count),
    setBreaker: (platform, reason) => {
      breaker.remove(platform, 'needs_login');
      breaker.remove(platform, 'checkpoint');
      if (reason !== undefined) breaker.labels(platform, reason).set(1);
    },
    render: () => registry.metrics(),
    contentType: registry.contentType,
  };
}

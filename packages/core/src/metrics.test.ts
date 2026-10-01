import { describe, expect, it } from 'vitest';
import { createMetrics } from './metrics';
import type { ToolOutcome } from './call';

const outcome = (over: Partial<ToolOutcome> = {}): ToolOutcome => ({
  tool: 'apec_search',
  adapter: 'apec',
  platform: 'apec',
  code: 'ok',
  durationMs: 250,
  requestId: 'r',
  argsHash: 'abcdef012345',
  ...over,
});

describe('createMetrics', () => {
  it('counts calls by tool, platform and result and times them', async () => {
    const metrics = createMetrics({ version: '1.2.3' });
    metrics.record(outcome());
    metrics.record(outcome());
    metrics.record(outcome({ code: 'needs_login', tool: 'linkedin_search', platform: 'linkedin', durationMs: 1500 }));
    const text = await metrics.render();
    expect(text).toContain('jw_tool_calls_total{tool="apec_search",platform="apec",result="ok"} 2');
    expect(text).toContain('jw_tool_calls_total{tool="linkedin_search",platform="linkedin",result="needs_login"} 1');
    expect(text).toContain('jw_tool_duration_seconds_count{tool="apec_search"} 2');
    expect(text).toContain('jw_tool_duration_seconds_sum{tool="linkedin_search"} 1.5');
  });

  it('reports build info and the number of enabled adapters', async () => {
    const metrics = createMetrics({ version: '1.2.3' });
    metrics.setEnabledAdapters(2);
    const text = await metrics.render();
    expect(text).toContain('jw_build_info{version="1.2.3"} 1');
    expect(text).toContain('jw_enabled_adapters 2');
    expect(text).toContain('process_cpu_user_seconds_total');
  });

  it('only exposes low-cardinality labels: never arguments, urls or request ids', async () => {
    const metrics = createMetrics({ version: 'x' });
    metrics.record(outcome({ requestId: 'secret-request-id' }));
    expect(await metrics.render()).not.toContain('secret-request-id');
  });

  it('keeps registries independent', async () => {
    const a = createMetrics({ version: 'a' });
    const b = createMetrics({ version: 'b' });
    a.record(outcome());
    expect(await b.render()).not.toContain('jw_tool_calls_total{');
  });

  it('serves the Prometheus text content type', () => {
    expect(createMetrics({ version: 'x' }).contentType).toContain('text/plain');
  });
});

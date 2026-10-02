import type { AdapterModule } from './adapter';
import { isHostEntry } from './hosts';
import { findInputSchemaProblems, inputJsonSchema, outputJsonSchema } from './schema';
import { SDK_API_VERSION } from './version';

export type Rule =
  | 'sdk-api'
  | 'id'
  | 'platform'
  | 'hosts'
  | 'rate'
  | 'pacing'
  | 'tools'
  | 'tool-name'
  | 'tool-unique'
  | 'read-only'
  | 'description'
  | 'limits'
  | 'schema'
  | 'schema-strict'
  | 'schema-bounded';

export interface Violation {
  rule: Rule;
  /** Where: `adapter`, or `tool:<name>`. */
  at: string;
  message: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
const OUTPUT_MAX_BYTES_CEILING = 262_144;

/**
 * The startup rules every adapter must satisfy (docs/plans/03-router-spec.md, "Rules the SDK and registry enforce").
 * Pure function: the engine calls it at startup (fail fast), the CLI calls it for `doctor`, and the
 * contract test of every adapter calls it. An empty array means the adapter is acceptable.
 * Uniqueness of tool names ACROSS adapters is the registry's job (it sees all adapters).
 */
export function validateAdapter(adapter: AdapterModule): Violation[] {
  const out: Violation[] = [];
  const add = (rule: Rule, at: string, message: string): void => {
    out.push({ rule, at, message });
  };

  if (adapter.sdkApi !== SDK_API_VERSION) {
    add('sdk-api', 'adapter', `sdkApi is ${adapter.sdkApi} but this engine implements SDK API ${SDK_API_VERSION}`);
  }
  if (!ID_PATTERN.test(adapter.id)) add('id', 'adapter', `id "${adapter.id}" must match ${ID_PATTERN}`);
  if (!ID_PATTERN.test(adapter.platform)) add('platform', 'adapter', `platform "${adapter.platform}" must match ${ID_PATTERN}`);

  if (adapter.allowedHosts.length === 0) add('hosts', 'adapter', 'allowedHosts must list at least one host');
  for (const host of adapter.allowedHosts) {
    if (!isHostEntry(host))
      add(
        'hosts',
        'adapter',
        `allowedHosts entry "${host}" must be a bare lowercase hostname or a one-label wildcard such as *.example.com (no scheme, port, path or IP)`,
      );
  }
  if (adapter.kind === 'browser' && (adapter as { openHttps?: unknown }).openHttps !== undefined)
    add('hosts', 'adapter', 'openHttps is only for kind "http" adapters');

  if (adapter.pacing !== undefined) {
    const { minMs, maxMs } = adapter.pacing;
    if (!Number.isInteger(minMs) || !Number.isInteger(maxMs) || minMs < 0 || maxMs < minMs || maxMs > 60_000) {
      add('pacing', 'adapter', 'pacing needs integers with 0 <= minMs <= maxMs <= 60000');
    }
  }

  if (adapter.rate !== undefined) {
    const { perHour, perDay } = adapter.rate;
    if (!Number.isInteger(perHour) || !Number.isInteger(perDay) || perHour < 1 || perDay < perHour || perDay > 100_000) {
      add('rate', 'adapter', 'rate needs integers with 1 <= perHour <= perDay <= 100000');
    } else {
      for (const tool of adapter.tools) {
        if (tool.limits.cost > perHour)
          add(
            'rate',
            `tool:${tool.name}`,
            `limits.cost (${tool.limits.cost}) is above rate.perHour (${perHour}): the tool could never run`,
          );
      }
    }
  }

  if (adapter.keyRate !== undefined) {
    const { perHour, perDay } = adapter.keyRate;
    if (!Number.isInteger(perHour) || !Number.isInteger(perDay) || perHour < 1 || perDay < perHour || perDay > 100_000) {
      add('rate', 'adapter', 'keyRate needs integers with 1 <= perHour <= perDay <= 100000');
    } else if (adapter.rate !== undefined && perHour > adapter.rate.perHour) {
      add(
        'rate',
        'adapter',
        `keyRate.perHour (${perHour}) is above rate.perHour (${adapter.rate.perHour}): the platform budget would always be hit first`,
      );
    }
  }
  for (const tool of adapter.tools) {
    if (tool.limits.keys !== undefined && adapter.keyRate === undefined)
      add('rate', `tool:${tool.name}`, 'limits.keys needs the adapter to declare keyRate, the budget of one key');
  }

  if (adapter.tools.length === 0) add('tools', 'adapter', 'an adapter must define at least one tool');

  const seen = new Set<string>();
  for (const tool of adapter.tools) {
    const at = `tool:${tool.name}`;
    if (!TOOL_NAME_PATTERN.test(tool.name)) add('tool-name', at, `tool name must match ${TOOL_NAME_PATTERN}`);
    if (seen.has(tool.name)) add('tool-unique', at, 'duplicate tool name inside the adapter');
    seen.add(tool.name);

    // Runtime check as well as the type: JavaScript callers and `as` casts must not slip a write tool through.
    if ((tool.annotations.readOnlyHint as boolean) !== true)
      add('read-only', at, 'annotations.readOnlyHint must be true: this project exposes read-only tools only');

    if (tool.title.trim().length === 0 || tool.title.length > 80) add('description', at, 'title must be 1-80 characters');
    if (tool.description.length < 20 || tool.description.length > 600) add('description', at, 'description must be 20-600 characters');
    if (!/read-only/i.test(tool.description)) add('description', at, 'description must state that the tool is read-only');

    const { timeoutS, cost, outputMaxBytes, memory } = tool.limits;
    if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 300)
      add('limits', at, 'limits.timeoutS must be an integer from 1 to 300');
    if (!Number.isInteger(cost) || cost < 1 || cost > 100) add('limits', at, 'limits.cost must be an integer from 1 to 100');
    if (!Number.isInteger(outputMaxBytes) || outputMaxBytes < 1024 || outputMaxBytes > OUTPUT_MAX_BYTES_CEILING) {
      add('limits', at, `limits.outputMaxBytes must be an integer from 1024 to ${OUTPUT_MAX_BYTES_CEILING}`);
    }
    if (memory !== undefined && !(memory.highMb >= 128 && memory.highMb < memory.maxMb && memory.maxMb <= 4096)) {
      add('limits', at, 'limits.memory needs 128 <= highMb < maxMb <= 4096');
    }

    try {
      for (const problem of findInputSchemaProblems(inputJsonSchema(tool.input))) {
        add(problem.kind === 'not-strict' ? 'schema-strict' : 'schema-bounded', at, `input ${problem.path}: ${problem.message}`);
      }
    } catch (error) {
      add('schema', at, `input schema cannot be expressed as JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      outputJsonSchema(tool.output);
    } catch (error) {
      add('schema', at, `output schema cannot be expressed as JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}

/** Human-readable multi-line report of violations (startup log, `jobwatch doctor`). */
export function formatViolations(adapterId: string, violations: readonly Violation[]): string {
  return [`Adapter "${adapterId}" is not acceptable:`, ...violations.map((v) => `  - [${v.rule}] ${v.at}: ${v.message}`)].join('\n');
}

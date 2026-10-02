import type { AdapterModule } from './adapter';
import { inputJsonSchema, outputJsonSchema, type JsonSchema } from './schema';

/** One tool as exposed by `tools/list`, in the snapshot format of docs/plans/04-catalog-and-tool-schemas.md. */
export interface CatalogEntry {
  name: string;
  title: string;
  description: string;
  platform: string;
  adapter: string;
  needs_browser: boolean;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: { readOnlyHint: true; openWorldHint: boolean; idempotentHint: boolean };
  limits: {
    timeout_s: number;
    memory?: { high_mb: number; max_mb: number };
    rate: { cost: number };
    output_max_bytes: number;
  };
  allowed_hosts: string[];
  /** Present (true) only for an adapter that may reach any public https host. */
  open_https?: boolean;
}

export function buildCatalog(adapter: AdapterModule): CatalogEntry[] {
  return adapter.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    platform: adapter.platform,
    adapter: adapter.id,
    needs_browser: adapter.kind === 'browser',
    inputSchema: inputJsonSchema(tool.input),
    outputSchema: outputJsonSchema(tool.output),
    annotations: { ...tool.annotations },
    limits: {
      timeout_s: tool.limits.timeoutS,
      ...(tool.limits.memory ? { memory: { high_mb: tool.limits.memory.highMb, max_mb: tool.limits.memory.maxMb } } : {}),
      rate: { cost: tool.limits.cost },
      output_max_bytes: tool.limits.outputMaxBytes,
    },
    allowed_hosts: [...adapter.allowedHosts],
    ...(adapter.kind === 'http' && adapter.openHttps === true ? { open_https: true } : {}),
  }));
}

/** File name of a tool's snapshot inside an adapter's `catalog/` folder. */
export function catalogFileName(toolName: string): string {
  return `${toolName}.json`;
}

/** Deterministic JSON: object keys sorted, 2-space indent, trailing newline. Snapshots are diffed in review. */
export function stableStringify(value: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(
        Object.entries(node)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return node;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

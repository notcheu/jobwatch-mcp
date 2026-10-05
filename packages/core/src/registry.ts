import {
  formatViolations,
  validateAdapter,
  type McpModule,
  type ErasedTool,
  type BaseContext,
  type CatalogEntry,
  buildCatalog,
} from '@jobwatch/sdk';

/**
 * The installed adapters: id to a loader. The list lives in `@jobwatch/adapters`; core only knows this shape,
 * so it never imports an adapter and the dependency rule (core depends on sdk only) holds.
 */
export type InstalledAdapters = Readonly<Record<string, () => Promise<McpModule>>>;

export class RegistryError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Cannot load adapters:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'RegistryError';
    this.problems = problems;
  }
}

export interface RegisteredTool {
  adapter: McpModule;
  tool: ErasedTool<BaseContext>;
}

export interface Registry {
  /** Built-in adapters first (the ops tools), then the enabled ones in the order they were requested. */
  readonly adapters: readonly McpModule[];
  /** Only the enabled, installed adapters (what `adapters.json` selects), without the built-ins. */
  readonly enabled: readonly McpModule[];
  /** Tool name to its adapter and definition. Names are unique across all enabled adapters. */
  readonly tools: ReadonlyMap<string, RegisteredTool>;
}

/**
 * Load the enabled adapters by id and check them. Fails fast with every problem at once:
 * unknown id, a module whose `id` differs from its key, any `validateAdapter` violation, duplicate tool names across
 * adapters, and adapters that share a platform but disagree on kind (they would share one runtime).
 * Only enabled adapters are imported; a disabled adapter costs nothing and exposes nothing.
 */
export async function loadAdapters(
  enabledIds: readonly string[],
  installed: InstalledAdapters,
  builtins: readonly McpModule[] = [],
): Promise<Registry> {
  const problems: string[] = [];
  const adapters: McpModule[] = [];

  // Built-ins (the ops tools) are part of the engine, always present, and held to the same rules as any adapter.
  for (const builtin of builtins) {
    const violations = validateAdapter(builtin);
    if (violations.length > 0) problems.push(formatViolations(builtin.id, violations));
    else adapters.push(builtin);
  }
  const builtinCount = adapters.length;

  for (const id of enabledIds) {
    if (builtins.some((builtin) => builtin.id === id)) {
      problems.push(`"${id}" is a reserved built-in id and cannot be installed or enabled`);
      continue;
    }
    const load = installed[id];
    if (load === undefined) {
      problems.push(`"${id}" is enabled but not installed (installed: ${Object.keys(installed).join(', ') || 'none'})`);
      continue;
    }
    let adapter: McpModule;
    try {
      adapter = await load();
    } catch (error) {
      problems.push(`"${id}" failed to load: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (adapter.id !== id) {
      problems.push(`installed as "${id}" but the module declares id "${adapter.id}"`);
      continue;
    }
    const violations = validateAdapter(adapter);
    if (violations.length > 0) {
      problems.push(formatViolations(id, violations));
      continue;
    }
    adapters.push(adapter);
  }

  const tools = new Map<string, RegisteredTool>();
  const platformKinds = new Map<string, { kind: string; adapterId: string }>();
  for (const adapter of adapters) {
    const seen = platformKinds.get(adapter.platform);
    if (seen !== undefined && seen.kind !== adapter.kind) {
      problems.push(
        `adapters "${seen.adapterId}" (${seen.kind}) and "${adapter.id}" (${adapter.kind}) share platform "${adapter.platform}" but differ in kind`,
      );
    } else if (seen === undefined) {
      platformKinds.set(adapter.platform, { kind: adapter.kind, adapterId: adapter.id });
    }
    for (const tool of adapter.tools) {
      const existing = tools.get(tool.name);
      if (existing !== undefined) {
        problems.push(`tool "${tool.name}" is defined by both "${existing.adapter.id}" and "${adapter.id}"`);
        continue;
      }
      tools.set(tool.name, { adapter, tool: tool as ErasedTool<BaseContext> });
    }
  }

  if (problems.length > 0) throw new RegistryError(problems);
  return { adapters, enabled: adapters.slice(builtinCount), tools };
}

/** What `tools/list` exposes for one tool (a subset of the catalog entry: nothing about limits or hosts). */
export interface ListedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: CatalogEntry['inputSchema'];
  outputSchema: CatalogEntry['outputSchema'];
  annotations: CatalogEntry['annotations'];
}

/**
 * The answer to `tools/list`. Pure data derived from the definitions: no handler runs, no container starts,
 * no network is touched, so it is safe and instant (CLAUDE.md: "Static schemas").
 */
export function listTools(registry: Registry): ListedTool[] {
  return registry.adapters.flatMap((adapter) =>
    buildCatalog(adapter).map((entry) => ({
      name: entry.name,
      title: entry.title,
      description: entry.description,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      annotations: entry.annotations,
    })),
  );
}

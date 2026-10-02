import type { Registry } from './registry';

export interface ReloadResult {
  /** The adapter ids that are enabled after the reload. */
  enabled: string[];
  addedAdapters: string[];
  removedAdapters: string[];
  addedTools: string[];
  removedTools: string[];
}

/**
 * The registry of enabled adapters, replaceable while the router runs (docs/plans/17-dashboard.md, section 6.4).
 *
 * `view` is a `Registry` that always reads the current one, so everything that was handed a registry (the MCP server, `callTool`)
 * keeps working without change and sees a reload on its next request. A call that already looked its tool up keeps that adapter and
 * tool for its whole life: a reload never changes what a running call does.
 *
 * `reload` builds and validates the new registry first (`load` throws with every problem when an adapter is unknown or broken) and
 * only then swaps, so a failed reload leaves the old registry untouched. Reloads run one at a time.
 */
export interface RegistryHolder {
  readonly view: Registry;
  current(): Registry;
  reload(ids: readonly string[]): Promise<ReloadResult>;
}

export function createRegistryHolder(
  initial: Registry,
  load: (ids: readonly string[]) => Promise<Registry>,
  onSwap: (next: Registry, previous: Registry) => void | Promise<void> = () => undefined,
): RegistryHolder {
  let current = initial;
  let queue: Promise<unknown> = Promise.resolve();

  const view: Registry = {
    get adapters() {
      return current.adapters;
    },
    get enabled() {
      return current.enabled;
    },
    get tools() {
      return current.tools;
    },
  };

  const reload = async (ids: readonly string[]): Promise<ReloadResult> => {
    const next = await load(ids);
    const previous = current;
    await onSwap(next, previous);
    current = next;
    const idsOf = (registry: Registry): Set<string> => new Set(registry.enabled.map((adapter) => adapter.id));
    const before = idsOf(previous);
    const after = idsOf(next);
    const toolsBefore = new Set(previous.tools.keys());
    const toolsAfter = new Set(next.tools.keys());
    const diff = (from: Set<string>, to: Set<string>): string[] => [...to].filter((id) => !from.has(id)).sort();
    return {
      enabled: [...after].sort(),
      addedAdapters: diff(before, after),
      removedAdapters: diff(after, before),
      addedTools: diff(toolsBefore, toolsAfter),
      removedTools: diff(toolsAfter, toolsBefore),
    };
  };

  return {
    view,
    current: () => current,
    reload: (ids) => {
      const run = queue.then(() => reload(ids));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

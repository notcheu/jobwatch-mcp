import { customToolName } from './module';

/** What a new custom adapter's name is checked against. */
export interface NameContext {
  /** The custom adapters that exist: their handle and the id of their module. */
  custom: readonly { handle: string; moduleId: string }[];
  /** Every module of the router, enabled or not, that is not a custom adapter: its id, its platform and the names of its tools. */
  modules: readonly { id: string; platform: string; tools: readonly string[] }[];
}

/**
 * What already has the id or the tool name of a new custom adapter, in words, or undefined when both are free. A new adapter is named by
 * its handle alone, so nothing stops it from being called `ashby` or `ashby_jobs`: this does. Two modules of one id, or two tools of one
 * name, would stop the router from starting, and an adapter that shadowed a real one would take its jobs, searches and budget.
 */
export function nameTakenBy(moduleId: string, context: NameContext): string | undefined {
  const toolName = customToolName(moduleId);
  for (const row of context.custom) {
    if (row.moduleId === moduleId) return 'the name of a custom adapter';
    if (customToolName(row.moduleId) === toolName) return `the tool of the custom adapter "${row.handle}"`;
  }
  for (const module of context.modules) {
    if (module.id === moduleId || module.platform === moduleId) return 'the name of an adapter of the router';
    if (module.tools.includes(toolName)) return `the name of a tool of the adapter "${module.id}"`;
  }
  return undefined;
}

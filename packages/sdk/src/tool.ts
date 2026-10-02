import type { z } from 'zod';
import type { BaseContext, BrowserAdapterContext, HttpAdapterContext } from './context';

export interface ToolAnnotations {
  /** Always `true`: this project never writes to a third-party platform. Checked at the type level and at startup. */
  readOnlyHint: true;
  openWorldHint: boolean;
  idempotentHint: boolean;
}

export interface ToolLimits<I = never> {
  /** Per-call timeout enforced by the engine. */
  timeoutS: number;
  /**
   * The MOST one call can cost (units taken from the platform's budget), 1 to 100. Used to check the tool can ever run, and as
   * the reservation when `estimate` is not given.
   */
  cost: number;
  /**
   * What THIS call is likely to need, from its validated arguments (for example one search page plus the jobs it will read, not the
   * worst case). The engine reserves it, clamped to 1..`cost`, so a small request is not refused for lack of room that a big one
   * would have needed. What the call really spends is measured, not estimated: see `AdapterResult.cost` and `ctx.spend`.
   */
  estimate?: (args: I) => number;
  /** Hard cap on the serialized result. */
  outputMaxBytes: number;
  /** Optional per-tool memory budget for the platform's browser runtime. */
  memory?: { highMb: number; maxMb: number };
}

/** What a handler returns. `data` must match the tool's `output` schema (validated before it leaves the engine). */
export interface AdapterResult<O extends object = Record<string, unknown>> {
  data: O;
  /** Optional compact Markdown view for the model. */
  text?: string;
  /** Non-fatal notes, e.g. "remote filter not applied by LinkedIn; post-filtered". */
  warnings: string[];
  /**
   * Budget units really spent (page views), a whole number. The engine reserves the call's estimate BEFORE it runs (so concurrent
   * calls cannot overshoot) and settles to what was spent afterwards: it refunds the difference, or records the excess. Omit it and
   * the engine uses what it MEASURED: every HTTP request and every page load (`goto`) the call made, plus what the adapter reported
   * with `ctx.spend`. A call that throws is charged what was measured, not the whole reservation.
   */
  cost?: number;
}

export interface ToolDefinition<I, O extends object, C extends BaseContext> {
  /** snake_case, globally unique, e.g. `apec_search`. */
  name: string;
  title: string;
  /** Sent on every `tools/list`: short, and it must state that the tool is read-only. */
  description: string;
  /** Strict (`.strict()`), every string and array bounded (`.max()`); the registry rejects anything looser. */
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  annotations: ToolAnnotations;
  limits: ToolLimits<I>;
  handler: (args: I, ctx: C) => Promise<AdapterResult<O>>;
}

/**
 * A tool with its argument type erased, so tools with different argument shapes fit in one array.
 * `never` as the argument type accepts any specific handler while keeping the context type strictly checked.
 * The engine validates the raw arguments with `input` first, then calls the handler (cast in one place, in core).
 */
export interface ErasedTool<C extends BaseContext> {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  annotations: ToolAnnotations;
  limits: ToolLimits;
  handler: (args: never, ctx: C) => Promise<AdapterResult>;
}

/** Define a tool of an HTTP adapter. The handler receives `{ http, log, pace }`. */
export function defineHttpTool<I, O extends object>(
  tool: ToolDefinition<I, O, HttpAdapterContext>,
): ToolDefinition<I, O, HttpAdapterContext> {
  return tool;
}

/** Define a tool of a browser adapter. The handler additionally receives the single-tab `session`. */
export function defineBrowserTool<I, O extends object>(
  tool: ToolDefinition<I, O, BrowserAdapterContext>,
): ToolDefinition<I, O, BrowserAdapterContext> {
  return tool;
}

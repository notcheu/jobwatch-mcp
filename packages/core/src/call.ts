import { createHash, randomUUID } from 'node:crypto';
import {
  ERROR_CODES,
  JobwatchError,
  type McpModule,
  type AdapterResult,
  type BaseContext,
  type ErasedTool,
  type ErrorBody,
  type ErrorCode,
} from '@jobwatch/sdk';
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens, jobTextChars } from './dashboard/tokens';
import type { EngineLogger } from './logging';
import type { Registry } from './registry';

/** Gives a handler its context (HTTP client, browser session, logger) and takes it back. Real providers arrive in steps 5 and 6. */
export interface ContextProvider {
  acquire(
    adapter: McpModule,
    requestId: string,
  ): Promise<{
    ctx: BaseContext;
    release: () => Promise<void>;
    signal?: AbortSignal;
    /** Budget units the call has spent so far: HTTP requests, page loads, and what the adapter reported with `ctx.spend`. */
    spent?: () => number;
  }>;
}

/** The provider of a build without a runtime: every acquisition fails with a clear `internal` error. */
export const noRuntime: ContextProvider = {
  acquire: () => Promise.reject(new JobwatchError('internal', 'No runtime is available in this build, so tools cannot run yet.')),
};

/**
 * Protections around a call. `admit` runs after the arguments are valid and before anything reaches the platform: it
 * throws a `JobwatchError` (`needs_login`, `checkpoint`, `rate_limited`) to refuse the call. `failed` is told about every
 * error the handler raised, so a lost session or a checkpoint can open the circuit breaker.
 */
/** Returned by `admit`: lets the call hand back budget it did not use. */
export interface Admission {
  /** Units reserved for the call before it ran. */
  reserved?: number;
  settle(actualCost: number): void;
}

export interface CallGuard {
  admit(adapter: McpModule, tool: ErasedTool<BaseContext>, args: unknown): Admission | undefined;
  failed(adapter: McpModule, error: JobwatchError): void;
}

/** Receives the outcome of every call (the call log). A recorder that throws never affects the call. */
export type CallRecorder = (outcome: ToolOutcome) => void;

/** Told when a call is admitted to run, so the dashboard can show it as running. */
export interface CallStart {
  requestId: string;
  tool: string;
  adapter: string;
  platform: string;
  startedAt: number;
}

export interface CallDeps {
  registry: Registry;
  contexts: ContextProvider;
  logger: EngineLogger;
  guard?: CallGuard;
  record?: CallRecorder;
  /** Called once per call, before the arguments are validated. */
  started?: (call: CallStart) => void;
  /** Characters per token for the estimate of what a result costs Claude (default 3.5). */
  tokenCharsPerToken?: number;
  /** Overridable for tests. */
  newRequestId?: () => string;
}

export interface ToolContent {
  type: 'text';
  text: string;
}

/** An MCP tool result. `_meta` carries what is not part of the tool's output schema. */
export interface ToolCallResult {
  isError: boolean;
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  _meta?: { jobwatch: { request_id: string; adapter: string; fetched_at: string; warnings: string[] } };
}

/** What the metrics and the access log record about one call. */
export interface ToolOutcome {
  tool: string;
  adapter: string;
  platform: string;
  code: 'ok' | ErrorCode;
  durationMs: number;
  requestId: string;
  /** Hash of the arguments, for correlating calls without storing them. */
  argsHash: string;
  /** What the dashboard keeps in memory about the call. Never persisted. */
  detail?: CallDetail;
}

/** The in-memory part of a call record (docs/plans/17-dashboard.md, section 4.2). */
export interface CallDetail {
  startedAt: number;
  unitsReserved: number;
  unitsSpent: number;
  /** Bytes of the text put in the MCP result. */
  responseBytes: number;
  /** Estimated tokens of that text: an estimate, not Claude's count. */
  estimatedTokens: number;
  warnings: number;
  /** The validated arguments, capped at MAX_PARAMS_BYTES. Kept in the call log and in the database (rotated after CALL_LOG_RETENTION_DAYS), never in the logs. */
  params: Record<string, unknown> | null;
  paramsTruncated: boolean;
  jobText?: { available: number; returned: number };
}

/** Most bytes of one call's parameters kept in memory; a longer object is replaced by its first bytes. */
export const MAX_PARAMS_BYTES = 16_384;

/** The parameters as a JSON object for the call history, cut at MAX_PARAMS_BYTES. */
export function paramsForHistory(args: unknown): { params: Record<string, unknown> | null; truncated: boolean } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return { params: null, truncated: false };
  const json = JSON.stringify(args);
  if (json.length <= MAX_PARAMS_BYTES) return { params: JSON.parse(json) as Record<string, unknown>, truncated: false };
  return { params: { _preview: json.slice(0, MAX_PARAMS_BYTES) }, truncated: true };
}

/** `delegatedBy`: the call is made by a gateway module for one of its own calls (`ctx.callTool`); such a call cannot delegate again. */
export interface CallOptions {
  delegatedBy?: McpModule;
}

/**
 * `ctx.callTool` of a gateway: runs the named tool as a full tool call (arguments, budget of the module that owns the tool,
 * timeout, output check, call log) and returns its validated output, or throws the tool's error. Only the tools of the modules
 * the gateway declares in `delegates.to` are reachable.
 */
function delegateFor(deps: CallDeps, gateway: McpModule): NonNullable<BaseContext['callTool']> {
  const allowed = gateway.delegates?.to ?? [];
  return async (toolName, args) => {
    const target = deps.registry.tools.get(toolName);
    if (target === undefined || !allowed.includes(target.adapter.id)) {
      throw new JobwatchError('invalid_arguments', `${toolName} is not a tool this module can call, or its module is not enabled.`, {
        details: { tool: toolName },
      });
    }
    const { result } = await callTool(deps, toolName, args, { delegatedBy: gateway });
    if (result.isError) {
      const text = result.content.map((part) => part.text).join('');
      let body: Partial<ErrorBody> = {};
      try {
        body = JSON.parse(text) as Partial<ErrorBody>;
      } catch {
        // not JSON: reported as an internal error below
      }
      const code = ERROR_CODES.find((candidate) => candidate === body.code) ?? 'internal';
      throw new JobwatchError(code, typeof body.message === 'string' ? body.message : 'The delegated tool failed.', {
        ...(typeof body.retry_after_s === 'number' ? { retryAfterS: body.retry_after_s } : {}),
        details: { tool: toolName },
      });
    }
    return result.structuredContent;
  };
}

export class UnknownToolError extends Error {
  constructor(readonly toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = 'UnknownToolError';
  }
}

const MAX_WARNINGS = 20;
const MAX_WARNING_CHARS = 300;

/** First 12 hex characters of a SHA-256 over the canonical JSON of the arguments: correlates calls without logging them. */
export function argsHash(args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(args ?? null))
    .digest('hex')
    .slice(0, 12);
}

function errorResult(body: ErrorBody, requestId: string): ToolCallResult {
  const withId = { ...body, details: { ...body.details, request_id: requestId } };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(withId) }] };
}

/** Reject as soon as `signal` aborts, with its reason when that is a JobwatchError (budget_exceeded, oom_killed, ...). */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  const toError = (): Error =>
    signal.reason instanceof Error ? signal.reason : new JobwatchError('internal', 'The browser stopped unexpectedly.');
  if (signal.aborted) return Promise.reject(toError());
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(toError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new JobwatchError('timeout', `The tool did not finish within ${ms / 1000} s.`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Run one tool call: find the tool, validate the arguments, give the handler its context, enforce the timeout, validate
 * the output against the tool's schema, enforce the size cap, and turn every failure into a client-safe error body.
 *
 * Throws `UnknownToolError` for a name that is not registered (a protocol error, not a tool error). Everything else
 * is returned as a result with `isError`. Rate limiting, the circuit breaker and the browser lease are added around
 * this function in later steps; the contract of this function does not change.
 *
 * Errors that are not `JobwatchError` are logged in full here and returned as a generic `internal` error: a message
 * from deep inside an adapter or a library may contain URLs, cookies or HTML.
 */
export async function callTool(
  deps: CallDeps,
  name: string,
  rawArgs: unknown,
  options: CallOptions = {},
): Promise<{ result: ToolCallResult; outcome: ToolOutcome }> {
  const registered = deps.registry.tools.get(name);
  if (registered === undefined) throw new UnknownToolError(name);
  const { adapter, tool } = registered;
  const requestId = (deps.newRequestId ?? randomUUID)();
  const started = performance.now();
  const log = deps.logger.child({ request_id: requestId, tool: name, adapter: adapter.id });

  const startedAt = Date.now();
  deps.started?.({ requestId, tool: name, adapter: adapter.id, platform: adapter.platform, startedAt });
  let admission: Admission | undefined;
  let lease: Awaited<ReturnType<ContextProvider['acquire']>> | undefined;
  // Units the handler reported itself (success only). Otherwise the engine's own count of what the call did is used.
  let reported: number | undefined;
  const seen: { validated?: unknown } = {};

  const finish = (result: ToolCallResult, code: ToolOutcome['code']): { result: ToolCallResult; outcome: ToolOutcome } => {
    const durationMs = Math.round(performance.now() - started);
    const hash = argsHash(rawArgs);
    const text = result.content.map((part) => part.text).join('');
    const history = paramsForHistory(seen.validated ?? rawArgs);
    const jobText = jobTextChars(result.structuredContent);
    const detail: CallDetail = {
      startedAt,
      unitsReserved: admission?.reserved ?? 0,
      unitsSpent: reported ?? lease?.spent?.() ?? 0,
      responseBytes: Buffer.byteLength(text),
      estimatedTokens: estimateTokens(text, deps.tokenCharsPerToken ?? DEFAULT_CHARS_PER_TOKEN),
      warnings: result._meta?.jobwatch.warnings.length ?? 0,
      params: history.params,
      paramsTruncated: history.truncated,
      ...(jobText === undefined ? {} : { jobText }),
    };
    log.info({ outcome: code, duration_ms: durationMs, args_hash: hash }, 'tool_call');
    const outcome: ToolOutcome = {
      tool: name,
      adapter: adapter.id,
      platform: adapter.platform,
      code,
      durationMs,
      requestId,
      argsHash: hash,
      detail,
    };
    try {
      deps.record?.(outcome);
    } catch (error) {
      // A broken call log must never turn a good result into a failure.
      log.error({ err: error }, 'call_record_failed');
    }
    return { result, outcome };
  };
  const fail = (body: ErrorBody) => finish(errorResult(body, requestId), body.code);

  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message }));
    return fail({
      code: 'invalid_arguments',
      message: 'The arguments do not match the tool input schema.',
      retry_after_s: null,
      details: { issues },
    });
  }

  seen.validated = parsed.data;
  try {
    admission = deps.guard?.admit(adapter, tool, parsed.data);
  } catch (error) {
    if (error instanceof JobwatchError) return fail(error.toBody());
    throw error;
  }

  try {
    lease = await deps.contexts.acquire(adapter, requestId);
    // A gateway gets the means to call the tools it delegates to; a tool called that way never gets them (one level only).
    if (adapter.delegates !== undefined && options.delegatedBy === undefined) lease.ctx.callTool = delegateFor(deps, adapter);
    // One cast, here: the registry stores tools with their argument type erased; `input` has just validated the arguments.
    const handler = tool.handler as (args: unknown, ctx: BaseContext) => Promise<AdapterResult>;
    const produced = await withTimeout(raceAbort(handler(parsed.data, lease.ctx), lease.signal), tool.limits.timeoutS * 1000);

    const checked = tool.output.safeParse(produced.data);
    if (!checked.success) {
      log.error(
        { issues: checked.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
        'output_schema_mismatch',
      );
      return fail({
        code: 'adapter_broken',
        message: 'The tool produced a result that does not match its output schema.',
        retry_after_s: null,
        details: {},
      });
    }
    const structured = checked.data as Record<string, unknown>;
    const warnings = produced.warnings.slice(0, MAX_WARNINGS).map((warning) => warning.slice(0, MAX_WARNING_CHARS));
    const body = produced.text ?? JSON.stringify(structured);
    const text = warnings.length > 0 ? `${body}\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join('\n')}` : body;

    const size = Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(structured));
    if (size > tool.limits.outputMaxBytes) {
      return fail({
        code: 'internal',
        message: `The result is larger than the tool's output limit (${tool.limits.outputMaxBytes} bytes).`,
        retry_after_s: null,
        details: { limit_bytes: tool.limits.outputMaxBytes },
      });
    }
    reported = produced.cost;
    const result: ToolCallResult = {
      isError: false,
      content: [{ type: 'text', text }],
      structuredContent: structured,
      _meta: { jobwatch: { request_id: requestId, adapter: adapter.id, fetched_at: new Date().toISOString(), warnings } },
    };
    return finish(result, 'ok');
  } catch (error) {
    if (error instanceof JobwatchError) {
      deps.guard?.failed(adapter, error);
      return fail(error.toBody());
    }
    log.error({ err: error }, 'tool_call_failed');
    return fail({ code: 'internal', message: 'Internal error.', retry_after_s: null, details: {} });
  } finally {
    // One place, whatever way the call ended: the reservation becomes what was really spent. A call that failed before touching
    // anything (no lease, a refused queue) costs nothing; one that failed half way costs what it did.
    if (reported !== undefined) admission?.settle(reported);
    else if (lease === undefined) admission?.settle(0);
    else if (lease.spent !== undefined) admission?.settle(lease.spent());
    // else: a provider that does not measure (only in tests) leaves the reservation as it was
    if (lease !== undefined) {
      await lease.release().catch((error: unknown) => log.error({ err: error }, 'context_release_failed'));
    }
  }
}

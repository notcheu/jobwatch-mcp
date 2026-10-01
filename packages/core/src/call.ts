import { createHash, randomUUID } from 'node:crypto';
import {
  JobwatchError,
  type AdapterModule,
  type AdapterResult,
  type BaseContext,
  type ErasedTool,
  type ErrorBody,
  type ErrorCode,
} from '@jobwatch/sdk';
import type { EngineLogger } from './logging';
import type { Registry } from './registry';

/** Gives a handler its context (HTTP client, browser session, logger) and takes it back. Real providers arrive in steps 5 and 6. */
export interface ContextProvider {
  acquire(adapter: AdapterModule, requestId: string): Promise<{ ctx: BaseContext; release: () => Promise<void> }>;
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
export interface CallGuard {
  admit(adapter: AdapterModule, tool: ErasedTool<BaseContext>): void;
  failed(adapter: AdapterModule, error: JobwatchError): void;
}

/** Receives the outcome of every call (the call log). A recorder that throws never affects the call. */
export type CallRecorder = (outcome: ToolOutcome) => void;

export interface CallDeps {
  registry: Registry;
  contexts: ContextProvider;
  logger: EngineLogger;
  guard?: CallGuard;
  record?: CallRecorder;
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
export async function callTool(deps: CallDeps, name: string, rawArgs: unknown): Promise<{ result: ToolCallResult; outcome: ToolOutcome }> {
  const registered = deps.registry.tools.get(name);
  if (registered === undefined) throw new UnknownToolError(name);
  const { adapter, tool } = registered;
  const requestId = (deps.newRequestId ?? randomUUID)();
  const started = performance.now();
  const log = deps.logger.child({ request_id: requestId, tool: name, adapter: adapter.id });

  const finish = (result: ToolCallResult, code: ToolOutcome['code']): { result: ToolCallResult; outcome: ToolOutcome } => {
    const durationMs = Math.round(performance.now() - started);
    const hash = argsHash(rawArgs);
    log.info({ outcome: code, duration_ms: durationMs, args_hash: hash }, 'tool_call');
    const outcome: ToolOutcome = {
      tool: name,
      adapter: adapter.id,
      platform: adapter.platform,
      code,
      durationMs,
      requestId,
      argsHash: hash,
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

  try {
    deps.guard?.admit(adapter, tool);
  } catch (error) {
    if (error instanceof JobwatchError) return fail(error.toBody());
    throw error;
  }

  let lease: Awaited<ReturnType<ContextProvider['acquire']>> | undefined;
  try {
    lease = await deps.contexts.acquire(adapter, requestId);
    // One cast, here: the registry stores tools with their argument type erased; `input` has just validated the arguments.
    const handler = tool.handler as (args: unknown, ctx: BaseContext) => Promise<AdapterResult>;
    const produced = await withTimeout(handler(parsed.data, lease.ctx), tool.limits.timeoutS * 1000);

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
    if (lease !== undefined) {
      await lease.release().catch((error: unknown) => log.error({ err: error }, 'context_release_failed'));
    }
  }
}

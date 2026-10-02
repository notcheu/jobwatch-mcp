/**
 * @jobwatch/sdk: the contract adapters are built on. This entry point imports nothing from Node, so adapter
 * code that depends on it cannot reach files, sockets or processes through it.
 *
 * Other entry points: `@jobwatch/sdk/testkit` (fakes + contract tests, for tests only)
 * and `@jobwatch/sdk/catalog-fs` (reads/writes catalog snapshots, for the CLI and the contract tests).
 */
export { SDK_API_VERSION } from './version';
export { z } from 'zod';

export { ERROR_CODES, JobwatchError, SessionInvalid, Checkpoint, AdapterBroken, UpstreamError, HostNotAllowedError } from './errors';
export type { ErrorCode, ErrorBody, ErrorOptions } from './errors';

export {
  isBareHostname,
  isWildcardHost,
  isHostEntry,
  isPublicHostname,
  matchHost,
  classifyUrl,
  isUrlAllowed,
  assertUrlAllowed,
  redactUrl,
} from './hosts';

export type {
  PaceKind,
  GotoOptions,
  BrowserSession,
  HttpRequestOptions,
  HttpResponse,
  HttpClient,
  Logger,
  BaseContext,
  NewJob,
  StoredJob,
  JobStore,
  HttpAdapterContext,
  BrowserAdapterContext,
  SessionState,
  SessionStatus,
} from './context';

export { defineHttpTool, defineBrowserTool } from './tool';
export type { ToolAnnotations, ToolLimits, AdapterResult, ToolDefinition, ErasedTool } from './tool';

export { defineAdapter, summarizeAdapter } from './adapter';
export type { AdapterModule, BrowserAdapter, HttpAdapter, AdapterKind, AdapterSummary, Pacing, RatePolicy } from './adapter';

export { validateAdapter, formatViolations } from './validate';
export type { Rule, Violation } from './validate';

export { buildCatalog, catalogFileName, stableStringify } from './catalog';
export type { CatalogEntry } from './catalog';

export { inputJsonSchema, outputJsonSchema, findInputSchemaProblems } from './schema';
export type { JsonSchema, SchemaProblem } from './schema';

export { extractHints, termMatcher } from './jobtext';
export type { Hints } from './jobtext';

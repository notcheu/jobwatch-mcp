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
  BrowserTab,
  PlatformMemory,
  CompanyBoards,
  PlaceHit,
  PlaceLog,
  CompanyBoardMatch,
  HttpRequestOptions,
  HttpResponse,
  HttpClient,
  Logger,
  BaseContext,
  NewJob,
  StoredJob,
  JobStore,
  SearchExclusion,
  SearchRecord,
  HttpAdapterContext,
  BrowserAdapterContext,
  SessionState,
  SessionStatus,
} from './context';

export { defineHttpTool, defineBrowserTool } from './tool';
export type { ToolAnnotations, ToolLimits, AdapterResult, ToolDefinition, ErasedTool, ToolExample } from './tool';

export { defineAdapter, defineUtility, roleOf, summarizeAdapter, summarizeModule, summarizeUtility } from './adapter';
export type {
  AdapterModule,
  BrowserAdapter,
  HttpAdapter,
  AdapterKind,
  AdapterSummary,
  McpModule,
  ModuleBase,
  ModuleRole,
  ModuleSummary,
  Pacing,
  RatePolicy,
  UtilityModule,
  UtilitySummary,
} from './adapter';

export { validateAdapter, formatViolations } from './validate';
export type { Rule, Violation } from './validate';

export { buildCatalog, catalogFileName, stableStringify } from './catalog';
export type { CatalogEntry } from './catalog';

export {
  ANY_SEPARATOR,
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  OR_SEPARATOR,
  PIPE_SEPARATOR,
  joinKeywords,
  keywordsSchema,
  splitKeywords,
} from './keywords';
export type { KeywordSeparator } from './keywords';
export { describeParams, sampleInput } from './docs';
export type { ParamDoc } from './docs';
export { inputJsonSchema, outputJsonSchema, findInputSchemaProblems } from './schema';
export type { JsonSchema, SchemaProblem } from './schema';

export {
  POSTED_WITHIN,
  containsAny,
  decodeEntities,
  extractHints,
  matchedTerms,
  fitToBytes,
  fold,
  htmlToText,
  postedCutoff,
  termMatcher,
} from './jobtext';
export type { Hints, PostedWithin } from './jobtext';
export { findSalary, findSalaryRange } from './salary';
export {
  LOCATION_LOOKUP_URL,
  bestLocation,
  forgetLocation,
  locationKey,
  lookupLocations,
  saveLocation,
  savedLocation,
  savedLocations,
} from './linkedinGeo';
export type { LocationHit, SavedLocation } from './linkedinGeo';
export type { Salary } from './salary';
export { salaryFilterFields, salaryFloor } from './salaryFilter';

export {
  boardExcludedSchema,
  boardFilters,
  boardJobSchema,
  boardReportSchema,
  boardToolOutput,
  boardsInput,
  detailFields,
  BoardHttpError,
  BoardNotFound,
  MAX_DETAIL_READS,
  expectBoardResponse,
  judgeBoardPostings,
  selectForDetail,
  runBoardTool,
  slugify,
  titleCase,
} from './boards';
export type {
  BoardAddress,
  BoardExcluded,
  BoardFilters,
  BoardJob,
  BoardPosting,
  BoardRead,
  BoardReport,
  BoardSource,
  Judged,
} from './boards';

export { readByIds, readNew, returnedIds } from './visit';
export type {
  AcceptedJob,
  ByIdOutcome,
  ByIdPlan,
  Excluded,
  ExcludedBy,
  Failed,
  JobCard,
  ReadOutcome,
  ReadPlan,
  Terms,
  VisitedPage,
} from './visit';

export { DETAILS, PARTS, describeJob, partsOf, splitSections, summarizeJob } from './summary';
export type { DescriptionFields, Detail, JobSummary, Part, Section } from './summary';

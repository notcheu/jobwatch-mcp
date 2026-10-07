/** @jobwatch/core: the engine. Depends on @jobwatch/sdk only; never imports an adapter. */
export { ConfigError } from './errors';
export { ENV_NAMES, envSchema, parseEnv } from './env';
export type { EnvResult, ParsedEnv } from './env';
export { ADAPTER_ID_PATTERN, describeConfig, loadConfig, loadStorageSettings, parseAdapterList } from './config';
export type { Config, LoadedConfig, StorageSettings } from './config';
export { createAdapterLogger, createLogger, sanitizeFields } from './logging';
export type { EngineLogger, LoggerOptions } from './logging';
export {
  ADAPTERS_FILE,
  adaptersFilePath,
  isPinned,
  pinVariable,
  readEnabledFile,
  resolveEnabledModules,
  setModulesEnabled,
  writeEnabledFile,
} from './adapters-config';
export type { EnabledModules, EnabledLists, EnabledSource, ModuleGroup, ToggleResult } from './adapters-config';
export { RegistryError, listTools, loadModules } from './registry';
export type { InstalledAdapters, InstalledModules, InstalledUtilities, ListedTool, RegisteredTool, Registry } from './registry';
export { MAX_PARAMS_BYTES, UnknownToolError, argsHash, callTool, noRuntime, paramsForHistory } from './call';
export type {
  Admission,
  CallDeps,
  CallDetail,
  CallGuard,
  CallRecorder,
  CallStart,
  ContextProvider,
  ToolCallResult,
  ToolContent,
  ToolOutcome,
} from './call';
export { createMetrics } from './metrics';
export * from './custom';
export { createCompanyBoards, createContextProvider, createJobStore, createPlaceLog, createPlatformMemory } from './contexts';
export type { ContextProviderDeps } from './contexts';
export { createHttpClient } from './http/client';
export type { HttpClientOptions } from './http/client';
export { createGuardedSession, mapBrowserError } from './browser/pageSession';
export type { PageLike } from './browser/pageSession';
export { FINGERPRINT_SCRIPT, checkFingerprint } from './browser/fingerprint';
export type { Fingerprint, FingerprintExpectations, FingerprintResult } from './browser/fingerprint';
export { DEFAULT_BROWSER_PACING, createPacer } from './browser/pacer';
export { createAttachHooks, createBrowserHooks, waitForDevTools } from './browser/hooks';
export type { BrowserHooksOptions, FingerprintMode } from './browser/hooks';
export { connectBrowser } from './browser/session';
export { createRegistryHolder, type RegistryHolder, type ReloadResult } from './registryHolder';
export {
  controlSocketPath,
  sendControl,
  startControlServer,
  type ControlHandler,
  type ControlRequest,
  type ControlResponse,
} from './control';
export { HEALTH_MAX_DISCARDED_SHARE, HEALTH_MIN_FOUND, HEALTH_MIN_RUNS_EMPTY, searchHealth } from './dashboard/searchHealth';
export type { HealthIssue, SearchHealth } from './dashboard/searchHealth';
export { CallLog, keywordsOf, type CallEntry, type CallQuery, type RestoredCall } from './dashboard/callLog';
export { DEFAULT_CHARS_PER_TOKEN, estimateTokens, jobTextChars } from './dashboard/tokens';
export type { BrowserConnection, ConnectBrowser } from './browser/session';
export { BackendError } from './runtime/backend';
export type { ContainerState, RuntimeBackend, RuntimeHandle, RuntimeSpec } from './runtime/backend';
export { AttachBackend } from './runtime/attachBackend';
export { LocalBackend, findChrome } from './runtime/localBackend';
export type { LocalBackendOptions } from './runtime/localBackend';
export { DockerCliBackend, LOGIN_LABEL, LOGIN_PORT, MANAGED_LABEL, loginRunArgs, runArgs, spawnDocker } from './runtime/dockerCli';
export type { CliResult, DockerRunner } from './runtime/dockerCli';
export { RuntimeManager } from './runtime/manager';
export type {
  Lease,
  LeaseOptions,
  ManagerConfig,
  MemoryLevel,
  RuntimeEvent,
  RuntimeHooks,
  RuntimeState,
  RuntimeStatus,
  StopReason,
} from './runtime/manager';
export { Semaphore } from './runtime/semaphore';
export type { Metrics } from './metrics';
export {
  DEFAULT_CALL_LOG_RETENTION_DAYS,
  DEFAULT_JOB_RETENTION_DAYS,
  DAILY_USAGE_RETENTION_DAYS,
  JOB_SORT_COLUMNS,
  MAX_JOB_DESCRIPTION_CHARS,
  SCHEMA_VERSION,
  Store,
  StoreError,
  CUSTOM_HANDLE,
  MAX_CUSTOM_SCRIPT_CHARS,
  USAGE_RETENTION_MS,
  keywordsKey,
  normalizeKeywords,
  normalizeTerms,
} from './store/store';
export type {
  AtsLookup,
  BreakerReason,
  CustomAdapterEvent,
  CustomAdapterRow,
  BreakerRow,
  CallRecord,
  CompanyBoard,
  PlaceLookup,
  Clock,
  DailyUsageDelta,
  DailyUsageRow,
  NewJobRow,
  StoredJobRow,
  ExcludedBy,
  JobSearch,
  SearchDetail,
  SearchDetailJob,
  SearchRef,
  SearchStat,
  StoredSalary,
  UsageEvent,
} from './store/store';
export { DEFAULT_RATE, effectiveRate } from './limits/policy';
export { RateLimiter } from './limits/ratelimit';
export type { RateStatus, UsageTicket, WindowUsage } from './limits/ratelimit';
export { CHECKPOINT_TTL_S, CircuitBreaker } from './limits/breaker';
export type { BreakerListener } from './limits/breaker';
export { createGuard, policyFor } from './limits/guard';
export {
  BUDGETS_FILE,
  BUDGET_MAX,
  BUDGET_MIN,
  BudgetLocked,
  Budgets,
  budgetBodySchema,
  budgetEnvName,
  readBudgetEnv,
} from './limits/budgets';
export type { Budget, BudgetDefaults, BudgetNumbers, BudgetSource, BudgetValue, BudgetWindow } from './limits/budgets';
export { FakeBackend } from './runtime/fake';
export { OPS_ADAPTER_ID, createOpsAdapter } from './ops/ops';
export type { PlatformStatus } from './ops/ops';
export type { OpsDeps } from './ops/ops';

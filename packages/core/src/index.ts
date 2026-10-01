/** @jobwatch/core: the engine. Depends on @jobwatch/sdk only; never imports an adapter. */
export { ConfigError } from './errors';
export { ADAPTER_ID_PATTERN, describeConfig, loadConfig, loadStorageSettings, parseAdapterList } from './config';
export type { Config, LoadedConfig, StorageSettings } from './config';
export { createAdapterLogger, createLogger, sanitizeFields } from './logging';
export type { EngineLogger, LoggerOptions } from './logging';
export {
  ADAPTERS_FILE,
  adaptersFilePath,
  readEnabledFile,
  resolveEnabledAdapters,
  setAdaptersEnabled,
  writeEnabledFile,
} from './adapters-config';
export type { EnabledAdapters, EnabledSource, ToggleResult } from './adapters-config';
export { RegistryError, listTools, loadAdapters } from './registry';
export type { InstalledAdapters, ListedTool, RegisteredTool, Registry } from './registry';
export { UnknownToolError, argsHash, callTool, noRuntime } from './call';
export type { CallDeps, CallGuard, CallRecorder, ContextProvider, ToolCallResult, ToolContent, ToolOutcome } from './call';
export { createMetrics } from './metrics';
export { BackendError } from './runtime/backend';
export type { ContainerState, RuntimeBackend, RuntimeHandle, RuntimeSpec } from './runtime/backend';
export { DockerCliBackend, MANAGED_LABEL, runArgs, spawnDocker } from './runtime/dockerCli';
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
export { CALL_LOG_RETENTION_MS, SCHEMA_VERSION, Store, StoreError, USAGE_RETENTION_MS } from './store/store';
export type { BreakerReason, BreakerRow, CallRecord, Clock, UsageEvent } from './store/store';
export { DEFAULT_RATE, effectiveRate } from './limits/policy';
export { RateLimiter } from './limits/ratelimit';
export type { RateStatus, WindowUsage } from './limits/ratelimit';
export { CHECKPOINT_TTL_S, CircuitBreaker } from './limits/breaker';
export type { BreakerListener } from './limits/breaker';
export { createGuard, policyFor } from './limits/guard';
export { FakeBackend } from './runtime/fake';

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
export type { CallDeps, ContextProvider, ToolCallResult, ToolContent, ToolOutcome } from './call';
export { createMetrics } from './metrics';
export type { Metrics } from './metrics';

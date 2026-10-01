/** @jobwatch/core: the engine. Depends on @jobwatch/sdk only; never imports an adapter. */
export { ConfigError } from './errors';
export { ADAPTER_ID_PATTERN, describeConfig, loadConfig, parseAdapterList } from './config';
export type { Config, LoadedConfig } from './config';
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

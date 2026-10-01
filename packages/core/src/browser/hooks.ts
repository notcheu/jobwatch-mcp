import { JobwatchError } from '@jobwatch/sdk';
import type { EngineLogger } from '../logging';
import type { RuntimeHandle } from '../runtime/backend';
import type { RuntimeHooks } from '../runtime/manager';
import { devtoolsBaseUrl } from './address';
import { FINGERPRINT_SCRIPT, checkFingerprint, type FingerprintExpectations } from './fingerprint';
import type { ConnectBrowser } from './session';

export type FingerprintMode = 'enforce' | 'warn' | 'off';

export interface BrowserHooksOptions {
  connect: ConnectBrowser;
  logger: EngineLogger;
  fingerprint: FingerprintMode;
  expectations: FingerprintExpectations;
  /** Hosts allowed during the self-check: it only reads about:blank, so none. */
  devtoolsTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll DevTools on the container IP until it answers (the port is internal-network only, never published). */
export async function waitForDevTools(
  address: string,
  timeoutMs: number,
  doFetch: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = sleepReal,
): Promise<void> {
  const base = devtoolsBaseUrl(address); // a malformed address is a bug: fail now, do not retry it until the deadline
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await doFetch(`${base}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) throw new Error('DevTools did not answer in time');
    await sleep(500);
  }
}

/** The browser-layer half of the runtime lifecycle: readiness and fingerprint, clean quit, memory shedding. */
export function createBrowserHooks(options: BrowserHooksOptions): RuntimeHooks {
  const { connect, logger } = options;
  return {
    async ready(handle: RuntimeHandle): Promise<void> {
      await waitForDevTools(handle.address, options.devtoolsTimeoutMs ?? 25_000, options.fetchImpl, options.sleep);
      if (options.fingerprint === 'off') return;
      const connection = await connect(handle.address, []);
      try {
        const result = checkFingerprint(await connection.session.evaluate(FINGERPRINT_SCRIPT), options.expectations);
        if (result.ok) return;
        logger.error({ platform: handle.platform, problems: result.problems }, 'fingerprint_mismatch');
        if (options.fingerprint === 'enforce')
          throw new JobwatchError('internal', 'The browser failed its startup fingerprint check.', {
            details: { platform: handle.platform },
          });
      } finally {
        await connection.disconnect();
      }
    },

    async quit(handle: RuntimeHandle): Promise<void> {
      const connection = await connect(handle.address, []);
      await connection.quit();
      await connection.disconnect();
    },

    async onWarn(handle: RuntimeHandle): Promise<void> {
      const connection = await connect(handle.address, []);
      try {
        await connection.shedMemory();
      } finally {
        await connection.disconnect();
      }
    },
  };
}

import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig, loadStorageSettings, parseAdapterList } from './config';
import { ConfigError } from './errors';

const base = { JW_BASE_URL: 'https://mcp.example.com' };
const problemsOf = (env: Record<string, string>): readonly string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
};

describe('loadConfig defaults', () => {
  it('needs only the public base URL', () => {
    const { config, warnings } = loadConfig(base);
    expect(warnings).toEqual([]);
    expect(config).toMatchObject({
      baseUrl: 'https://mcp.example.com',
      auth: 'front',
      listenHost: '0.0.0.0',
      port: 8080,
      runtime: 'docker',
      dataDir: '/data',
      adaptersFromEnv: undefined,
      idleTtlS: 120,
      maxLifetimeS: 1800,
      queueTimeoutS: 60,
      memHighMb: 1200,
      memMaxMb: 1500,
      logLevel: 'info',
      metrics: { enabled: false, port: 9464 },
    });
  });

  it('refuses to start without a base URL, saying what to set', () => {
    expect(problemsOf({})).toEqual(['JW_BASE_URL: is required: the public URL, e.g. https://mcp.example.com']);
    expect(problemsOf({ JW_BASE_URL: 'not a url' })).toEqual(['JW_BASE_URL: must be an http(s) URL, e.g. https://mcp.example.com']);
    expect(problemsOf({ JW_BASE_URL: 'ftp://mcp.example.com' })).toEqual([
      'JW_BASE_URL: must be an http(s) URL, e.g. https://mcp.example.com',
    ]);
  });

  it('treats empty values like unset (docker compose passes VAR= for missing interpolations)', () => {
    const { config } = loadConfig({ ...base, JW_PORT: '', JW_LOG_LEVEL: '', JW_FRONT_SHARED_SECRET: '' });
    expect(config.port).toBe(8080);
    expect(config.frontSharedSecret).toBeUndefined();
  });

  it('normalises the base URL (no trailing slash)', () => {
    expect(loadConfig({ JW_BASE_URL: 'https://mcp.example.com/' }).config.baseUrl).toBe('https://mcp.example.com');
  });
});

describe('loadConfig validation', () => {
  it('coerces and bounds numbers', () => {
    expect(loadConfig({ ...base, JW_PORT: '18931', JW_MEM_MAX_MB: '2000' }).config).toMatchObject({ port: 18931, memMaxMb: 2000 });
    for (const [key, value] of [
      ['JW_PORT', '80'],
      ['JW_PORT', 'abc'],
      ['JW_IDLE_TTL_S', '5'],
      ['JW_MEM_MAX_MB', '100000'],
      ['JW_QUEUE_TIMEOUT_S', '1.5'],
    ] as const) {
      expect(problemsOf({ ...base, [key]: value }), `${key}=${value}`).not.toEqual([]);
    }
  });

  it('rejects an unknown log level or runtime', () => {
    expect(problemsOf({ ...base, JW_LOG_LEVEL: 'loud' })).not.toEqual([]);
    expect(problemsOf({ ...base, JW_RUNTIME: 'podman' })).not.toEqual([]);
  });

  it('requires the high memory mark to be below the hard cap', () => {
    expect(problemsOf({ ...base, JW_MEM_HIGH_MB: '1500', JW_MEM_MAX_MB: '1500' })).toContain(
      'JW_MEM_HIGH_MB must be lower than JW_MEM_MAX_MB',
    );
  });

  it('never serves metrics on the MCP port', () => {
    expect(problemsOf({ ...base, JW_METRICS_ENABLED: 'true', JW_PORT: '9000', JW_METRICS_PORT: '9000' })).toContainEqual(
      expect.stringContaining('JW_METRICS_PORT must differ'),
    );
    expect(problemsOf({ ...base, JW_METRICS_ENABLED: 'false', JW_PORT: '9000', JW_METRICS_PORT: '9000' })).toEqual([]);
  });

  it('requires a long enough shared secret', () => {
    expect(problemsOf({ ...base, JW_FRONT_SHARED_SECRET: 'short' })).not.toEqual([]);
  });

  it('collects every problem at once', () => {
    expect(problemsOf({ JW_PORT: 'x', JW_LOG_LEVEL: 'loud', JW_MEM_HIGH_MB: '10' }).length).toBeGreaterThanOrEqual(4);
  });

  it('warns about unknown JW_ variables and ignores other variables', () => {
    const { warnings } = loadConfig({ ...base, JW_PROT: '1', PATH: '/usr/bin' });
    expect(warnings).toEqual(['JW_PROT is not a known setting and is ignored (typo?)']);
  });
});

describe('transport and authentication rules', () => {
  it('refuses plain http for a public hostname', () => {
    expect(problemsOf({ JW_BASE_URL: 'http://mcp.example.com' })).toContainEqual(
      expect.stringContaining('http is only allowed for localhost'),
    );
  });

  it('allows JW_AUTH=none only with a loopback base URL', () => {
    expect(loadConfig({ JW_BASE_URL: 'http://127.0.0.1:18932', JW_AUTH: 'none' }).config.auth).toBe('none');
    expect(loadConfig({ JW_BASE_URL: 'http://localhost:8080', JW_AUTH: 'none' }).config.auth).toBe('none');
    expect(problemsOf({ ...base, JW_AUTH: 'none' })).toContainEqual(expect.stringContaining('JW_AUTH=none is only allowed'));
    expect(problemsOf({ JW_BASE_URL: 'https://127.0.0.1.evil.com', JW_AUTH: 'none' })).not.toEqual([]);
  });
});

describe('browser runtime settings', () => {
  it('defaults the network and leaves the seccomp profile unset', () => {
    expect(loadConfig(base).config).toMatchObject({ browserNetwork: 'jobwatch-browsers', browserSeccomp: undefined });
  });

  it('accepts an absolute seccomp path and a network name, and rejects relative paths and odd names', () => {
    expect(
      loadConfig({ ...base, JW_BROWSER_SECCOMP: '/etc/jobwatch/chrome-seccomp.json', JW_BROWSER_NETWORK: 'jobwatch_jobwatch-browsers' })
        .config,
    ).toMatchObject({
      browserSeccomp: '/etc/jobwatch/chrome-seccomp.json',
      browserNetwork: 'jobwatch_jobwatch-browsers',
    });
    expect(problemsOf({ ...base, JW_BROWSER_SECCOMP: 'relative.json' })).not.toEqual([]);
    expect(problemsOf({ ...base, JW_BROWSER_NETWORK: 'bad name --x' })).not.toEqual([]);
  });
});

describe('JW_ADAPTERS', () => {
  it('parses a comma list; an empty string means explicitly none', () => {
    expect(loadConfig({ ...base, JW_ADAPTERS: 'linkedin, apec' }).config.adaptersFromEnv).toEqual(['linkedin', 'apec']);
    expect(loadConfig({ ...base, JW_ADAPTERS: '' }).config.adaptersFromEnv).toEqual([]);
    expect(loadConfig(base).config.adaptersFromEnv).toBeUndefined();
  });

  it('rejects invalid and duplicate ids', () => {
    expect(parseAdapterList('linkedin,Linkedin').problems).toHaveLength(1);
    expect(parseAdapterList('linkedin,linkedin').problems).toEqual(['JW_ADAPTERS: "linkedin" is listed twice']);
    expect(parseAdapterList('../etc').problems).toHaveLength(1);
    expect(problemsOf({ ...base, JW_ADAPTERS: 'a b' })).not.toEqual([]);
  });
});

describe('secrets never leak', () => {
  const secret = 's3cr3t-shared-value-123';

  it('describeConfig redacts the shared secret', () => {
    const { config } = loadConfig({ ...base, JW_FRONT_SHARED_SECRET: secret });
    expect(JSON.stringify(describeConfig(config))).not.toContain(secret);
    expect(describeConfig(config)['frontSharedSecret']).toBe('[redacted]');
  });

  it('error messages carry variable names and reasons, not values', () => {
    const message = (() => {
      try {
        loadConfig({ ...base, JW_FRONT_SHARED_SECRET: 'tooshort-secret', JW_PORT: 'not-a-number-value' });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();
    expect(message).toContain('JW_FRONT_SHARED_SECRET');
    expect(message).not.toContain('tooshort-secret');
    expect(message).not.toContain('not-a-number-value');
  });
});

describe('loadStorageSettings (what the CLI needs)', () => {
  it('works without a base URL and defaults to /data', () => {
    expect(loadStorageSettings({})).toEqual({ dataDir: '/data', adaptersFromEnv: undefined });
  });

  it('reads the data directory and the adapter list', () => {
    expect(loadStorageSettings({ JW_DATA_DIR: './data', JW_ADAPTERS: 'linkedin,apec' })).toEqual({
      dataDir: './data',
      adaptersFromEnv: ['linkedin', 'apec'],
    });
    expect(loadStorageSettings({ JW_DATA_DIR: '', JW_ADAPTERS: '' })).toEqual({ dataDir: '/data', adaptersFromEnv: [] });
  });

  it('rejects an invalid adapter list with the same rules as the server', () => {
    expect(() => loadStorageSettings({ JW_ADAPTERS: '../etc' })).toThrow(ConfigError);
    expect(() => loadStorageSettings({ JW_ADAPTERS: 'ab,ab' })).toThrow(/listed twice/);
  });

  it('ignores every other variable, including invalid ones the server would refuse', () => {
    expect(loadStorageSettings({ JW_PORT: 'nope', JW_BASE_URL: 'ftp://x' })).toEqual({ dataDir: '/data', adaptersFromEnv: undefined });
  });
});

describe('multi-tab', () => {
  it('allows 3 tabs by default', () => {
    expect(loadConfig(base).config.maxTabs).toBe(3);
  });

  it('JW_BROWSER_MAX_TABS sets the limit: 1 is a single tab, more than 1 is multi-tab, no upper limit', () => {
    expect(loadConfig({ ...base, JW_BROWSER_MAX_TABS: '1' }).config.maxTabs).toBe(1);
    expect(loadConfig({ ...base, JW_BROWSER_MAX_TABS: '8' }).config.maxTabs).toBe(8);
    expect(loadConfig({ ...base, JW_BROWSER_MAX_TABS: '500' }).config.maxTabs).toBe(500);
  });

  it('refuses 0, a negative number and a non-integer', () => {
    for (const value of ['0', '-2', '2.5', 'many']) expect(problemsOf({ ...base, JW_BROWSER_MAX_TABS: value }), value).toHaveLength(1);
  });
});

describe('dashboard keys', () => {
  it('keeps 2000 calls and estimates 3.5 characters per token by default', () => {
    const { config } = loadConfig(base);
    expect([config.callBuffer, config.charsPerToken]).toEqual([2000, 3.5]);
  });

  it('takes the buffer size (100 to 20000) and a ratio (1 to 10)', () => {
    const { config } = loadConfig({ ...base, JW_DASHBOARD_CALL_BUFFER: '500', JW_TOKEN_CHARS_PER_TOKEN: '4' });
    expect([config.callBuffer, config.charsPerToken]).toEqual([500, 4]);
    expect(problemsOf({ ...base, JW_DASHBOARD_CALL_BUFFER: '5' })).toHaveLength(1);
    expect(problemsOf({ ...base, JW_TOKEN_CHARS_PER_TOKEN: '0' })).toHaveLength(1);
  });
});

describe('dashboard sign-in config', () => {
  it('has no Google client unless both id and secret are given, and never prints the secret', () => {
    expect(loadConfig(base).config.dashboard.oidc).toBeUndefined();
    expect(loadConfig({ ...base, JW_DASHBOARD_OIDC_CLIENT_ID: 'id-only' }).config.dashboard.oidc).toBeUndefined();
    const { config } = loadConfig({ ...base, JW_DASHBOARD_OIDC_CLIENT_ID: 'the-id', JW_DASHBOARD_OIDC_CLIENT_SECRET: 'the-secret-value' });
    expect(config.dashboard.oidc).toEqual({ issuer: 'https://accounts.google.com', clientId: 'the-id', clientSecret: 'the-secret-value' });
    expect(JSON.stringify(describeConfig(config))).not.toContain('the-secret-value');
  });

  it('has the timers of the plan by default: 30 minutes idle, 8 hours session, 10 minutes for writes', () => {
    const { dashboard } = loadConfig(base).config;
    expect([dashboard.port, dashboard.idleS, dashboard.sessionMaxS, dashboard.writeWindowS]).toEqual([8090, 1800, 28_800, 600]);
  });
});

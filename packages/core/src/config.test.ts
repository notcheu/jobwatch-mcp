import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig, loadStorageSettings, parseAdapterList } from './config';
import { ConfigError } from './errors';

const base = { BASE_URL: 'https://mcp.example.com' };
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
    expect(problemsOf({})).toEqual(['BASE_URL: is required: the public URL, e.g. https://mcp.example.com']);
    expect(problemsOf({ BASE_URL: 'not a url' })).toEqual(['BASE_URL: must be an http(s) URL, e.g. https://mcp.example.com']);
    expect(problemsOf({ BASE_URL: 'ftp://mcp.example.com' })).toEqual(['BASE_URL: must be an http(s) URL, e.g. https://mcp.example.com']);
  });

  it('treats empty values like unset (docker compose passes VAR= for missing interpolations)', () => {
    const { config } = loadConfig({ ...base, PORT: '', LOG_LEVEL: '', FRONT_SHARED_SECRET: '' });
    expect(config.port).toBe(8080);
    expect(config.frontSharedSecret).toBeUndefined();
  });

  it('normalises the base URL (no trailing slash)', () => {
    expect(loadConfig({ BASE_URL: 'https://mcp.example.com/' }).config.baseUrl).toBe('https://mcp.example.com');
  });
});

describe('loadConfig validation', () => {
  it('coerces and bounds numbers', () => {
    expect(loadConfig({ ...base, PORT: '18931', BROWSER_MEM_MAX_MB: '2000' }).config).toMatchObject({ port: 18931, memMaxMb: 2000 });
    for (const [key, value] of [
      ['PORT', '80'],
      ['PORT', 'abc'],
      ['BROWSER_IDLE_TTL_S', '5'],
      ['BROWSER_MEM_MAX_MB', '100000'],
      ['BROWSER_QUEUE_TIMEOUT_S', '1.5'],
    ] as const) {
      expect(problemsOf({ ...base, [key]: value }), `${key}=${value}`).not.toEqual([]);
    }
  });

  it('rejects an unknown log level or runtime', () => {
    expect(problemsOf({ ...base, LOG_LEVEL: 'loud' })).not.toEqual([]);
    expect(problemsOf({ ...base, BROWSER_RUNTIME: 'podman' })).not.toEqual([]);
  });

  it('requires the high memory mark to be below the hard cap', () => {
    expect(problemsOf({ ...base, BROWSER_MEM_HIGH_MB: '1500', BROWSER_MEM_MAX_MB: '1500' })).toContain(
      'BROWSER_MEM_HIGH_MB must be lower than BROWSER_MEM_MAX_MB',
    );
  });

  it('never serves metrics on the MCP port', () => {
    expect(problemsOf({ ...base, METRICS_ENABLED: 'true', PORT: '9000', METRICS_PORT: '9000' })).toContainEqual(
      expect.stringContaining('METRICS_PORT must differ'),
    );
    expect(problemsOf({ ...base, METRICS_ENABLED: 'false', PORT: '9000', METRICS_PORT: '9000' })).toEqual([]);
  });

  it('requires a long enough shared secret', () => {
    expect(problemsOf({ ...base, FRONT_SHARED_SECRET: 'short' })).not.toEqual([]);
  });

  it('collects every problem at once', () => {
    expect(problemsOf({ PORT: 'x', LOG_LEVEL: 'loud', BROWSER_MEM_HIGH_MB: '10' }).length).toBeGreaterThanOrEqual(4);
  });

  it('ignores the variables of other tools', () => {
    expect(loadConfig({ ...base, PATH: '/usr/bin', HOME: '/root' }).warnings).toEqual([]);
  });

  it('reports a variable that still has the old JW_ prefix, and does not read it', () => {
    const { config, warnings } = loadConfig({ ...base, JW_PORT: '9000' });
    expect(config.port).toBe(8080);
    expect(warnings).toEqual(['JW_PORT is not read any more: the JW_ prefix was dropped (PORT)']);
  });
});

describe('transport and authentication rules', () => {
  it('refuses plain http for a public hostname', () => {
    expect(problemsOf({ BASE_URL: 'http://mcp.example.com' })).toContainEqual(
      expect.stringContaining('http is only allowed for localhost'),
    );
  });

  it('allows AUTH=none only with a loopback base URL', () => {
    expect(loadConfig({ BASE_URL: 'http://127.0.0.1:18932', AUTH: 'none' }).config.auth).toBe('none');
    expect(loadConfig({ BASE_URL: 'http://localhost:8080', AUTH: 'none' }).config.auth).toBe('none');
    expect(problemsOf({ ...base, AUTH: 'none' })).toContainEqual(expect.stringContaining('AUTH=none is only allowed'));
    expect(problemsOf({ BASE_URL: 'https://127.0.0.1.evil.com', AUTH: 'none' })).not.toEqual([]);
  });
});

describe('browser runtime settings', () => {
  it('defaults the network and leaves the seccomp profile unset', () => {
    expect(loadConfig(base).config).toMatchObject({ browserNetwork: 'jobwatch-browsers', browserSeccomp: undefined });
  });

  it('accepts an absolute seccomp path and a network name, and rejects relative paths and odd names', () => {
    expect(
      loadConfig({ ...base, BROWSER_SECCOMP: '/etc/jobwatch/chrome-seccomp.json', BROWSER_NETWORK: 'jobwatch_jobwatch-browsers' }).config,
    ).toMatchObject({
      browserSeccomp: '/etc/jobwatch/chrome-seccomp.json',
      browserNetwork: 'jobwatch_jobwatch-browsers',
    });
    expect(problemsOf({ ...base, BROWSER_SECCOMP: 'relative.json' })).not.toEqual([]);
    expect(problemsOf({ ...base, BROWSER_NETWORK: 'bad name --x' })).not.toEqual([]);
  });
});

describe('ADAPTERS', () => {
  it('parses a comma list; an empty string means explicitly none', () => {
    expect(loadConfig({ ...base, ADAPTERS: 'linkedin, apec' }).config.adaptersFromEnv).toEqual(['linkedin', 'apec']);
    expect(loadConfig({ ...base, ADAPTERS: '' }).config.adaptersFromEnv).toEqual([]);
    expect(loadConfig(base).config.adaptersFromEnv).toBeUndefined();
  });

  it('rejects invalid and duplicate ids', () => {
    expect(parseAdapterList('linkedin,Linkedin').problems).toHaveLength(1);
    expect(parseAdapterList('linkedin,linkedin').problems).toEqual(['ADAPTERS: "linkedin" is listed twice']);
    expect(parseAdapterList('../etc').problems).toHaveLength(1);
    expect(problemsOf({ ...base, ADAPTERS: 'a b' })).not.toEqual([]);
  });
});

describe('secrets never leak', () => {
  const secret = 's3cr3t-shared-value-123';

  it('describeConfig redacts the shared secret', () => {
    const { config } = loadConfig({ ...base, FRONT_SHARED_SECRET: secret });
    expect(JSON.stringify(describeConfig(config))).not.toContain(secret);
    expect(describeConfig(config)['frontSharedSecret']).toBe('[redacted]');
  });

  it('error messages carry variable names and reasons, not values', () => {
    const message = (() => {
      try {
        loadConfig({ ...base, FRONT_SHARED_SECRET: 'tooshort-secret', PORT: 'not-a-number-value' });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();
    expect(message).toContain('FRONT_SHARED_SECRET');
    expect(message).not.toContain('tooshort-secret');
    expect(message).not.toContain('not-a-number-value');
  });
});

describe('loadStorageSettings (what the CLI needs)', () => {
  it('works without a base URL and defaults to /data', () => {
    expect(loadStorageSettings({})).toEqual({ dataDir: '/data', adaptersFromEnv: undefined });
  });

  it('reads the data directory and the adapter list', () => {
    expect(loadStorageSettings({ DATA_DIR: './data', ADAPTERS: 'linkedin,apec' })).toEqual({
      dataDir: './data',
      adaptersFromEnv: ['linkedin', 'apec'],
    });
    expect(loadStorageSettings({ DATA_DIR: '', ADAPTERS: '' })).toEqual({ dataDir: '/data', adaptersFromEnv: [] });
  });

  it('rejects an invalid adapter list with the same rules as the server', () => {
    expect(() => loadStorageSettings({ ADAPTERS: '../etc' })).toThrow(ConfigError);
    expect(() => loadStorageSettings({ ADAPTERS: 'ab,ab' })).toThrow(/listed twice/);
  });

  it('ignores every other variable, including invalid ones the server would refuse', () => {
    expect(loadStorageSettings({ PORT: 'nope', BASE_URL: 'ftp://x' })).toEqual({ dataDir: '/data', adaptersFromEnv: undefined });
  });
});

describe('multi-tab', () => {
  it('allows 3 tabs by default', () => {
    expect(loadConfig(base).config.maxTabs).toBe(3);
  });

  it('BROWSER_MAX_TABS sets the limit: 1 is a single tab, more than 1 is multi-tab, no upper limit', () => {
    expect(loadConfig({ ...base, BROWSER_MAX_TABS: '1' }).config.maxTabs).toBe(1);
    expect(loadConfig({ ...base, BROWSER_MAX_TABS: '8' }).config.maxTabs).toBe(8);
    expect(loadConfig({ ...base, BROWSER_MAX_TABS: '500' }).config.maxTabs).toBe(500);
  });

  it('refuses 0, a negative number and a non-integer', () => {
    for (const value of ['0', '-2', '2.5', 'many']) expect(problemsOf({ ...base, BROWSER_MAX_TABS: value }), value).toHaveLength(1);
  });
});

describe('dashboard keys', () => {
  it('keeps 2000 calls and estimates 3.5 characters per token by default', () => {
    const { config } = loadConfig(base);
    expect([config.callBuffer, config.charsPerToken]).toEqual([2000, 3.5]);
  });

  it('takes the buffer size (100 to 20000) and a ratio (1 to 10)', () => {
    const { config } = loadConfig({ ...base, DASHBOARD_CALL_BUFFER: '500', TOKEN_CHARS_PER_TOKEN: '4' });
    expect([config.callBuffer, config.charsPerToken]).toEqual([500, 4]);
    expect(problemsOf({ ...base, DASHBOARD_CALL_BUFFER: '5' })).toHaveLength(1);
    expect(problemsOf({ ...base, TOKEN_CHARS_PER_TOKEN: '0' })).toHaveLength(1);
  });
});

describe('dashboard sign-in config', () => {
  it('has no Google client unless both id and secret are given, and never prints the secret', () => {
    expect(loadConfig(base).config.dashboard.oidc).toBeUndefined();
    expect(loadConfig({ ...base, DASHBOARD_OIDC_CLIENT_ID: 'id-only' }).config.dashboard.oidc).toBeUndefined();
    const { config } = loadConfig({ ...base, DASHBOARD_OIDC_CLIENT_ID: 'the-id', DASHBOARD_OIDC_CLIENT_SECRET: 'the-secret-value' });
    expect(config.dashboard.oidc).toEqual({ issuer: 'https://accounts.google.com', clientId: 'the-id', clientSecret: 'the-secret-value' });
    expect(JSON.stringify(describeConfig(config))).not.toContain('the-secret-value');
  });

  it("signs in with the OAuth front's client unless the dashboard has one of its own", () => {
    const front = {
      ...base,
      OIDC_CLIENT_ID: 'front-id',
      OIDC_CLIENT_SECRET: 'front-secret-value',
      OIDC_ISSUER_URL: 'https://idp.example.com',
    };
    expect(loadConfig(front).config.dashboard.oidc).toEqual({
      issuer: 'https://idp.example.com',
      clientId: 'front-id',
      clientSecret: 'front-secret-value',
    });
    const own = loadConfig({ ...front, DASHBOARD_OIDC_CLIENT_ID: 'own-id', DASHBOARD_OIDC_CLIENT_SECRET: 'own-secret-value' });
    expect(own.config.dashboard.oidc).toMatchObject({ clientId: 'own-id', clientSecret: 'own-secret-value' });
    expect(JSON.stringify(describeConfig(own.config))).not.toContain('own-secret-value');
  });

  it('has the timers of the plan by default: 30 minutes idle, 8 hours session, 10 minutes for writes', () => {
    const { dashboard } = loadConfig(base).config;
    expect([dashboard.port, dashboard.idleS, dashboard.sessionMaxS, dashboard.writeWindowS]).toEqual([8090, 1800, 28_800, 600]);
  });
});

describe('dashboard address', () => {
  it('is the public URL behind the reverse proxy', () => {
    expect(loadConfig(base).config.dashboard.url).toBe('https://mcp.example.com/dashboard/');
  });

  it('is its own port when there is no proxy (AUTH=none), because the MCP port does not serve it', () => {
    const local = { AUTH: 'none', BASE_URL: 'http://127.0.0.1:18931' };
    expect(loadConfig(local).config.dashboard.url).toBe('http://127.0.0.1:8090/dashboard/');
    expect(loadConfig({ ...local, DASHBOARD_PORT: '18933' }).config.dashboard.url).toBe('http://127.0.0.1:18933/dashboard/');
  });

  it('takes DASHBOARD_URL over both', () => {
    expect(
      loadConfig({ AUTH: 'none', BASE_URL: 'http://127.0.0.1:18931', DASHBOARD_URL: 'http://localhost:9/d/' }).config.dashboard.url,
    ).toBe('http://localhost:9/d/');
  });
});

describe('browser mode', () => {
  it('is docker by default', () => {
    expect(loadConfig(base).config).toMatchObject({ browserMode: 'docker', browserCdpAddress: undefined });
  });

  it('starts a local Chrome with BROWSER_LOCAL_CHROME', () => {
    expect(loadConfig({ ...base, BROWSER_LOCAL_CHROME: 'true' }).config.browserMode).toBe('local');
  });

  it('attaches to a running Chrome with BROWSER_CDP_URL, localhost included', () => {
    expect(loadConfig({ ...base, BROWSER_CDP_URL: 'http://127.0.0.1:9222' }).config).toMatchObject({
      browserMode: 'attach',
      browserCdpAddress: '127.0.0.1:9222',
    });
    expect(loadConfig({ ...base, BROWSER_CDP_URL: 'http://localhost:9333' }).config.browserCdpAddress).toBe('127.0.0.1:9333');
  });

  it('refuses a DevTools URL that is not loopback, has no port or is not http', () => {
    for (const url of ['http://192.168.1.5:9222', 'http://example.com:9222', 'http://127.0.0.1', 'https://127.0.0.1:9222', 'nonsense'])
      expect(problemsOf({ ...base, BROWSER_CDP_URL: url }), url).toEqual([expect.stringContaining('BROWSER_CDP_URL')]);
  });

  it('attaches when both are set: the running Chrome wins, with a warning', () => {
    const { config, warnings } = loadConfig({ ...base, BROWSER_LOCAL_CHROME: 'true', BROWSER_CDP_URL: 'http://127.0.0.1:9222' });
    expect(config.browserMode).toBe('attach');
    expect(warnings).toEqual([expect.stringContaining('BROWSER_LOCAL_CHROME is ignored')]);
  });

  it('warns about a Chrome path that nothing uses', () => {
    expect(loadConfig({ ...base, BROWSER_LOCAL_CHROME_PATH: '/usr/bin/chrome' }).warnings).toEqual([
      expect.stringContaining('BROWSER_LOCAL_CHROME_PATH'),
    ]);
  });
});

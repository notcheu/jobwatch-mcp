import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { BackendError, LOGIN_PORT, loadConfig, loginRunArgs, type RuntimeSpec } from '@jobwatch/core';
import { describeInstalledAdapters } from '@jobwatch/mcp-modules';
import type { Deps } from './cli';

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_FAILED = 2;
const DOCKER_TIMEOUT_MS = 60_000;

/** x11vnc only reads the first 8 characters of a password, so make exactly 8 and make them random. */
export function randomVncPassword(): string {
  return randomBytes(6).toString('base64url').slice(0, 8);
}

export const loginContainerName = (platform: string): string => `jw-login-${platform}`;

const LOGIN_USAGE = `Usage:
  jobwatch login start <platform> [--port 6080]   start a visible browser on the platform's profile
  jobwatch login stop <platform>                  stop it (the profile keeps the session)
`;

/**
 * Manual login (docs/plans/05-browser-runtime.md, "Login procedure"): a headful browser on the platform's persistent profile, reached
 * through noVNC published on the host's loopback only. The viewer is never started by a tool call and never public.
 */
export async function login(deps: Deps, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: 'string', default: String(LOGIN_PORT) } },
  });
  const [action, platform, ...extra] = positionals;
  if ((action !== 'start' && action !== 'stop') || platform === undefined || extra.length > 0) {
    deps.io.err(LOGIN_USAGE);
    return EXIT_USAGE;
  }
  const entries = await describeInstalledAdapters(deps.adapters);
  const adapter = entries.find((entry) => entry.summary?.kind === 'browser' && entry.summary.platform === platform)?.summary;
  if (adapter === undefined) {
    const known = [...new Set(entries.flatMap((entry) => (entry.summary?.kind === 'browser' ? [entry.summary.platform] : [])))];
    deps.io.err(`No installed browser adapter for platform "${platform}". Browser platforms: ${known.join(', ') || 'none'}\n`);
    return EXIT_USAGE;
  }
  const docker = deps.docker;
  if (docker === undefined) {
    deps.io.err('Docker is not available to this command.\n');
    return EXIT_FAILED;
  }
  const name = loginContainerName(platform);

  if (action === 'stop') {
    await docker(['stop', '-t', '20', name], { timeoutMs: DOCKER_TIMEOUT_MS });
    await docker(['rm', '-f', name], { timeoutMs: DOCKER_TIMEOUT_MS });
    deps.io.out(
      `Login browser for ${platform} stopped; the profile keeps the session.\nCheck it: call the session_status tool for ${platform}.\n`,
    );
    return EXIT_OK;
  }

  const port = Number(values.port);
  const { config } = loadConfig(deps.env);

  // The profile cannot be opened by two Chrome processes: the router's own browser must not be running on it.
  const running = await docker(['inspect', '-f', '{{.State.Running}}', `jw-${platform}`], { timeoutMs: DOCKER_TIMEOUT_MS });
  if (running.code === 0 && running.stdout.trim() === 'true') {
    deps.io.err(
      `The router's browser for ${platform} is running on the profile. Wait for its idle stop (${config.idleTtlS} s) and retry.\n`,
    );
    return EXIT_FAILED;
  }

  const password = (deps.randomPassword ?? randomVncPassword)();
  const startUrl = `https://${adapter.allowedHosts[0] ?? ''}/`;
  const spec: RuntimeSpec = {
    platform,
    name,
    image: config.browserImage,
    memoryMb: config.memMaxMb,
    memoryReservationMb: config.memHighMb,
    profileVolume: `${config.profileVolumePrefix}${platform}`,
    // Not the internal browsers network: Docker cannot publish a port from an internal network, and the person signing in
    // needs the internet. The router never talks to this container; the viewer is published on the host's loopback only.
    network: 'bridge',
    ...(config.browserSeccomp ? { seccompProfile: config.browserSeccomp } : {}),
    env: {
      CHROME_LANG: config.browserLang,
      ...(config.browserAcceptLangs ? { ACCEPT_LANGS: config.browserAcceptLangs.join(',') } : {}),
      MODE: 'login',
      VNC_PASSWORD: password,
      START_URL: startUrl,
    },
  };
  let runArgs: string[];
  try {
    runArgs = loginRunArgs(spec, port);
  } catch (error) {
    if (error instanceof BackendError) {
      deps.io.err(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }

  await docker(['rm', '-f', name], { timeoutMs: DOCKER_TIMEOUT_MS }); // a previous login, if any
  const started = await docker(runArgs, { timeoutMs: DOCKER_TIMEOUT_MS });
  if (started.code !== 0) {
    deps.io.err(`docker could not start the login browser: ${started.stderr.trim().slice(0, 500)}\n`);
    return EXIT_FAILED;
  }
  deps.io.out(
    [
      `Login browser for ${platform} started on ${startUrl}`,
      '',
      '1. From your laptop, open a tunnel to this machine:',
      `     ssh -L ${port}:localhost:${port} <user>@<this-host>`,
      `2. Open http://localhost:${port}/vnc.html and connect with the password: ${password}`,
      `3. Sign in by hand (captcha, phone confirmation), then browse once to a page that needs the session.`,
      `4. Stop it:  jobwatch login stop ${platform}`,
      '',
      "The viewer listens on this machine's loopback only. The password is valid until you stop it.",
      '',
    ].join('\n'),
  );
  return EXIT_OK;
}

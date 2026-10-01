import { access, constants } from 'node:fs/promises';
import { ConfigError, type Config, loadConfig, loadStorageSettings, resolveEnabledAdapters } from '@jobwatch/core';
import { describeInstalled } from '@jobwatch/adapters';
import type { Deps } from './cli';

type Level = 'ok' | 'warn' | 'fail';
interface Check {
  level: Level;
  name: string;
  detail: string;
}

const MARK: Record<Level, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

/** Read-only diagnosis of the installation. Nothing is started, changed or logged in. Exit 0 unless a check FAILS. */
export async function doctor(deps: Deps): Promise<number> {
  const checks: Check[] = [];
  const add = (level: Level, name: string, detail: string): void => void checks.push({ level, name, detail });

  let config: Config | undefined;
  try {
    config = loadConfig(deps.env).config;
    add('ok', 'configuration', 'JW_* settings are valid');
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    add('fail', 'configuration', error.problems.join('; '));
  }

  const settings = loadStorageSettings(deps.env);
  await access(settings.dataDir, constants.W_OK).then(
    () => add('ok', 'data directory', `${settings.dataDir} is writable`),
    () => add('fail', 'data directory', `${settings.dataDir} is missing or not writable by this user`),
  );

  const entries = await describeInstalled(deps.installed);
  for (const entry of entries.filter((candidate) => candidate.error !== undefined))
    add('fail', `adapter ${entry.id}`, `broken: ${entry.error ?? 'unknown'}`);
  const enabled = (await resolveEnabledAdapters(settings)).ids;
  for (const id of enabled.filter((candidate) => !(candidate in deps.installed))) add('fail', `adapter ${id}`, 'enabled but not installed');
  add('ok', 'adapters', `${entries.length} installed, ${enabled.length} enabled`);

  const platforms = [
    ...new Set(
      entries.flatMap((entry) => (entry.summary?.kind === 'browser' && enabled.includes(entry.id) ? [entry.summary.platform] : [])),
    ),
  ];
  if (platforms.length === 0) {
    add('ok', 'browser runtime', 'no enabled browser adapter: Docker is not needed');
  } else if (deps.docker === undefined || config === undefined) {
    add('fail', 'browser runtime', 'cannot check Docker without a valid configuration');
  } else {
    const docker = deps.docker;
    const probe = (args: string[]) =>
      docker(args, { timeoutMs: 30_000 }).catch((error: unknown) => ({ code: -1, stdout: '', stderr: String(error) }));
    const version = await probe(['version', '--format', '{{.Server.Version}}']);
    if (version.code !== 0) add('fail', 'docker', `the daemon is unreachable: ${version.stderr.trim().slice(0, 200)}`);
    else add('ok', 'docker', `daemon ${version.stdout.trim()}`);
    if (version.code === 0) {
      add((await probe(['image', 'inspect', config.browserImage])).code === 0 ? 'ok' : 'fail', 'browser image', config.browserImage);
      add(
        (await probe(['network', 'inspect', config.browserNetwork])).code === 0 ? 'ok' : 'fail',
        'browser network',
        config.browserNetwork,
      );
      for (const platform of platforms) {
        const volume = `${config.profileVolumePrefix}${platform}`;
        const found = (await probe(['volume', 'inspect', volume])).code === 0;
        add(
          found ? 'ok' : 'warn',
          `profile ${platform}`,
          found ? volume : `${volume} does not exist yet: run "jobwatch login ${platform}"`,
        );
      }
    }
    if (config.browserSeccomp !== undefined) {
      await access(config.browserSeccomp, constants.R_OK).then(
        () => add('ok', 'seccomp profile', config.browserSeccomp ?? ''),
        () => add('fail', 'seccomp profile', `${config.browserSeccomp} is not readable`),
      );
    }
  }

  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) deps.io.out(`${MARK[check.level]}  ${check.name.padEnd(width)}  ${check.detail}\n`);
  const failures = checks.filter((check) => check.level === 'fail').length;
  deps.io.out(failures === 0 ? '\nNo problem found.\n' : `\n${failures} problem(s) found.\n`);
  return failures === 0 ? 0 : 2;
}

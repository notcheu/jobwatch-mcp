import { describe, expect, it } from 'vitest';
import { BackendError, type RuntimeSpec } from './backend';
import { DockerCliBackend, MANAGED_LABEL, loginRunArgs, runArgs, type CliResult, type DockerRunner } from './dockerCli';

const spec: RuntimeSpec = {
  platform: 'linkedin',
  name: 'jw-linkedin',
  image: 'registry.example.com/jobwatch-browser:154-1',
  memoryMb: 1500,
  memoryReservationMb: 1200,
  profileVolume: 'jw-profile-linkedin',
  network: 'jobwatch-browsers',
  seccompProfile: '/etc/jobwatch/chrome-seccomp.json',
  env: { CHROME_LANG: 'fr-FR', ACCEPT_LANGS: 'fr-FR,en-GB,sv-SE,ja-JP' },
};

const inspectJson = (over: object = {}) =>
  JSON.stringify([
    {
      State: { Running: true, OOMKilled: false, ExitCode: 0 },
      NetworkSettings: { Networks: { 'jobwatch-browsers': { IPAddress: '172.18.0.5' } } },
      ...over,
    },
  ]);

/** A scripted docker: records calls, answers by subcommand. */
function fakeDocker(handlers: Record<string, (args: readonly string[]) => Partial<CliResult>> = {}): {
  run: DockerRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: DockerRunner = async (args) => {
    calls.push([...args]);
    const handler = handlers[args[0] ?? ''];
    const result = handler ? handler(args) : {};
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  return { run, calls };
}

describe('runArgs: the hardening is pinned', () => {
  const args = runArgs(spec);
  const has = (...sequence: string[]) => args.some((_a, i) => sequence.every((part, j) => args[i + j] === part));

  it('applies every flag of the documented container spec', () => {
    expect(has('--memory', '1500m')).toBe(true);
    expect(has('--memory-swap', '1500m')).toBe(true); // no swap for the browser
    expect(has('--memory-reservation', '1200m')).toBe(true);
    expect(has('--oom-score-adj', '500')).toBe(true); // die before mongod, mariadb, grafana
    expect(has('--pids-limit', '512')).toBe(true);
    expect(has('--shm-size', '256m')).toBe(true);
    expect(has('--cpus', '1.5')).toBe(true);
    expect(has('--cap-drop', 'ALL')).toBe(true);
    expect(has('--security-opt', 'no-new-privileges')).toBe(true);
    expect(has('--security-opt', 'seccomp=/etc/jobwatch/chrome-seccomp.json')).toBe(true);
    expect(args).toContain('--read-only');
    expect(args).toContain('--init');
    expect(has('--tmpfs', '/home/chrome:rw,size=64m,uid=1000,gid=1000')).toBe(true);
    expect(has('-v', 'jw-profile-linkedin:/profile')).toBe(true);
    expect(has('--network', 'jobwatch-browsers')).toBe(true);
  });

  it('labels the container so orphans can be found, and never publishes a port or mounts the host', () => {
    expect(has('--label', MANAGED_LABEL)).toBe(true);
    expect(has('--label', 'jobwatch.platform=linkedin')).toBe(true);
    for (const forbidden of ['-p', '--publish', '--privileged', '--cap-add', '--pid', '--net=host', '--network=host', '--volumes-from']) {
      expect(args, forbidden).not.toContain(forbidden);
    }
    // the only -v is the named profile volume (no host path)
    expect(args.filter((a, i) => args[i - 1] === '-v')).toEqual(['jw-profile-linkedin:/profile']);
  });

  it('puts the image last, after `--`, so it can never be read as an option', () => {
    expect(args.slice(-2)).toEqual(['--', 'registry.example.com/jobwatch-browser:154-1']);
  });

  it('passes environment values verbatim, including commas (an Accept-Language list)', () => {
    expect(has('-e', 'ACCEPT_LANGS=fr-FR,en-GB,sv-SE,ja-JP')).toBe(true);
  });

  it('omits the seccomp flag when no profile is configured (docker default profile)', () => {
    expect(runArgs({ ...spec, seccompProfile: undefined }).join(' ')).not.toContain('seccomp');
  });

  it('refuses hostile or malformed values before anything runs', () => {
    const bad: Partial<RuntimeSpec>[] = [
      { name: '--privileged' },
      { name: 'jw linkedin' },
      { name: 'jw-x; rm -rf /' },
      { image: '--privileged' },
      { image: 'img name' },
      { profileVolume: '/etc:/profile' },
      { profileVolume: '../x' },
      { network: 'host --privileged' },
      { memoryMb: 10 },
      { memoryMb: 1500.5 },
      { memoryMb: 1_000_000 },
      { memoryReservationMb: 2000 },
      { seccompProfile: 'relative/path.json' },
      { seccompProfile: '/ok,seccomp=unconfined' },
      { seccompProfile: '/ok\nbad' },
      { env: { 'BAD NAME': 'x' } },
      { env: { '--x': 'y' } },
      { env: { OK: 'line1\nline2' } },
      { env: { OK: 'nul\0byte' } },
      { platform: 'LinkedIn' },
    ];
    for (const patch of bad) expect(() => runArgs({ ...spec, ...patch }), JSON.stringify(patch)).toThrow(BackendError);
  });

  it('every returned argument is a plain string element: nothing is ever joined into a shell line', () => {
    expect(args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('DockerCliBackend.start', () => {
  const address = '172.18.0.5';

  it('removes a stale container, runs, then reads the address from inspect', async () => {
    const docker = fakeDocker({ inspect: () => ({ stdout: inspectJson() }) });
    const handle = await new DockerCliBackend(docker.run, 'jobwatch-browsers').start(spec);
    expect(handle).toEqual({ name: 'jw-linkedin', platform: 'linkedin', address });
    expect(docker.calls.map((c) => c[0])).toEqual(['rm', 'run', 'inspect']);
    expect(docker.calls[0]).toEqual(['rm', '-f', 'jw-linkedin']);
  });

  it('fails with the docker error text (for the log) when run fails', async () => {
    const docker = fakeDocker({ run: () => ({ code: 125, stderr: 'docker: Error response from daemon: Conflict.' }) });
    await expect(new DockerCliBackend(docker.run, 'jobwatch-browsers').start(spec)).rejects.toThrow(
      /docker run failed \(exit 125\): docker: Error response/,
    );
  });

  it('fails when the container is not running right after start, or has no address on the network', async () => {
    const notRunning = fakeDocker({ inspect: () => ({ stdout: inspectJson({ State: { Running: false } }) }) });
    await expect(new DockerCliBackend(notRunning.run, 'jobwatch-browsers').start(spec)).rejects.toThrow(/not running right after start/);
    const noAddress = fakeDocker({ inspect: () => ({ stdout: inspectJson({ NetworkSettings: { Networks: {} } }) }) });
    await expect(new DockerCliBackend(noAddress.run, 'jobwatch-browsers').start(spec)).rejects.toThrow(
      /no address on network jobwatch-browsers/,
    );
  });

  it('does not run anything for an invalid spec', async () => {
    const docker = fakeDocker();
    await expect(new DockerCliBackend(docker.run, 'jobwatch-browsers').start({ ...spec, image: '--privileged' })).rejects.toThrow(
      BackendError,
    );
    expect(docker.calls.filter((c) => c[0] === 'run')).toEqual([]);
  });
});

describe('DockerCliBackend.stop and remove', () => {
  const handle = { name: 'jw-linkedin', platform: 'linkedin', address: '172.18.0.5' };

  it('stops with the grace period, then removes', async () => {
    const docker = fakeDocker();
    await new DockerCliBackend(docker.run, 'n').stop(handle, 10);
    expect(docker.calls).toEqual([
      ['stop', '-t', '10', 'jw-linkedin'],
      ['rm', '-f', 'jw-linkedin'],
    ]);
  });

  it('clamps the grace period to a sane range', async () => {
    const docker = fakeDocker();
    const backend = new DockerCliBackend(docker.run, 'n');
    await backend.stop(handle, 0);
    await backend.stop(handle, 9999);
    expect(docker.calls.filter((c) => c[0] === 'stop').map((c) => c[2])).toEqual(['1', '60']);
  });

  it('treats a container that is already gone as stopped', async () => {
    const docker = fakeDocker({
      stop: () => ({ code: 1, stderr: 'Error response from daemon: No such container: jw-linkedin' }),
      rm: () => ({ code: 1, stderr: 'Error: No such container: jw-linkedin' }),
    });
    await expect(new DockerCliBackend(docker.run, 'n').stop(handle, 10)).resolves.toBeUndefined();
  });

  it('reports a real stop or remove failure', async () => {
    const stopFails = fakeDocker({ stop: () => ({ code: 1, stderr: 'permission denied' }) });
    await expect(new DockerCliBackend(stopFails.run, 'n').stop(handle, 10)).rejects.toThrow(/docker stop failed/);
    const rmFails = fakeDocker({ rm: () => ({ code: 1, stderr: 'device busy' }) });
    await expect(new DockerCliBackend(rmFails.run, 'n').remove('jw-x')).rejects.toThrow(/docker rm failed/);
  });

  it('refuses an invalid container name', async () => {
    const docker = fakeDocker();
    await expect(new DockerCliBackend(docker.run, 'n').remove('--all')).rejects.toThrow(BackendError);
    expect(docker.calls).toEqual([]);
  });
});

describe('DockerCliBackend.inspect, memory and listing', () => {
  const handle = { name: 'jw-linkedin', platform: 'linkedin', address: 'x' };

  it('reports running, oom-killed and exit code', async () => {
    const running = fakeDocker({ inspect: () => ({ stdout: inspectJson() }) });
    expect(await new DockerCliBackend(running.run, 'jobwatch-browsers').inspect(handle)).toEqual({
      running: true,
      oomKilled: false,
      exitCode: 0,
    });
    const killed = fakeDocker({ inspect: () => ({ stdout: inspectJson({ State: { Running: false, OOMKilled: true, ExitCode: 137 } }) }) });
    expect(await new DockerCliBackend(killed.run, 'jobwatch-browsers').inspect(handle)).toEqual({
      running: false,
      oomKilled: true,
      exitCode: 137,
    });
  });

  it('treats a missing container as not running', async () => {
    const gone = fakeDocker({ inspect: () => ({ code: 1, stderr: 'Error: No such object: jw-linkedin' }) });
    expect(await new DockerCliBackend(gone.run, 'n').inspect(handle)).toEqual({ running: false, oomKilled: false, exitCode: null });
  });

  it('reads the working set through a constant script (no interpolation of any input)', async () => {
    const docker = fakeDocker({ exec: () => ({ stdout: '734003200\n' }) });
    expect(await new DockerCliBackend(docker.run, 'n').memoryBytes(handle)).toBe(734_003_200);
    const [, name, shell, flag, script] = docker.calls[0] ?? [];
    expect([name, shell, flag]).toEqual(['jw-linkedin', 'sh', '-c']);
    expect(script).toContain('memory.current');
    expect(script).toContain('inactive_file');
    expect(script).not.toContain('jw-linkedin');
  });

  it('rejects an unreadable memory value instead of guessing', async () => {
    for (const stdout of ['', 'NaN', '-5', '1e9', 'abc', '12 34']) {
      const docker = fakeDocker({ exec: () => ({ stdout }) });
      await expect(new DockerCliBackend(docker.run, 'n').memoryBytes(handle), JSON.stringify(stdout)).rejects.toThrow(BackendError);
    }
  });

  it('lists managed containers by label and ignores anything that is not a valid name', async () => {
    const docker = fakeDocker({ ps: () => ({ stdout: 'jw-linkedin\n jw-apec \n\n--bad\nOTHER UPPER\n' }) });
    expect(await new DockerCliBackend(docker.run, 'n').listManaged()).toEqual(['jw-linkedin', 'jw-apec']);
    expect(docker.calls[0]).toEqual(['ps', '-a', '--filter', `label=${MANAGED_LABEL}`, '--format', '{{.Names}}']);
  });

  it('rejects inspect output that is not JSON or empty', async () => {
    await expect(new DockerCliBackend(fakeDocker({ inspect: () => ({ stdout: 'oops' }) }).run, 'n').start(spec)).rejects.toThrow(
      /not JSON/,
    );
    await expect(new DockerCliBackend(fakeDocker({ inspect: () => ({ stdout: '[]' }) }).run, 'n').start(spec)).rejects.toThrow(
      /no container/,
    );
  });
});

describe('loginRunArgs', () => {
  const login = { ...spec, name: 'jw-login-linkedin', env: { ...spec.env, MODE: 'login', VNC_PASSWORD: 'abc12345' } };

  it('is the hardened run plus a loopback-only noVNC port and its own label', () => {
    const args = loginRunArgs(login, 6080);
    expect(args).toContain('jobwatch.login=true');
    expect(args).not.toContain('jobwatch.managed=true');
    const publish = args[args.indexOf('-p') + 1];
    expect(publish).toBe('127.0.0.1:6080:6080');
    for (const flag of ['--read-only', '--cap-drop', '--memory']) expect(args).toContain(flag);
    expect(args.at(-2)).toBe('--');
  });

  it('refuses privileged or invalid host ports', () => {
    for (const port of [0, 80, 1023, 70_000, 6080.5]) expect(() => loginRunArgs(login, port)).toThrow(BackendError);
  });
});

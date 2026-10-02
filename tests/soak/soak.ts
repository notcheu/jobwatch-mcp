/**
 * Soak test of a RUNNING router (docs/plans/11-testing-and-validation.md: 6 h of periodic calls, no growth in router RSS, no leaked
 * containers, logs clean). Plain Node 26 (types are stripped), no dependencies, read-only: it only calls the tools you list.
 *
 *   docker run --rm --network jobwatch_jobwatch-core -e SOAK_SECRET=<JW_FRONT_SHARED_SECRET> \
 *     -v "$PWD/tests/soak:/soak:ro" node:26-bookworm-slim node /soak/soak.ts
 *
 * Settings (environment):
 *   SOAK_URL         default http://router:8080/mcp
 *   SOAK_SECRET      Bearer token the router expects (JW_FRONT_SHARED_SECRET); empty only for JW_AUTH=none
 *   SOAK_HOURS       default 6 (SOAK_SECONDS overrides, for a quick check)
 *   SOAK_MIN_S/MAX_S pause between rounds, random in [min, max]; default 300 and 1200
 *   SOAK_CALLS       semicolon list of `tool` or `tool=<json args>`; default `memory_report`. The first round always runs
 *                    every call; add e.g. `linkedin_search={"keywords":"frontend"}` ONLY after Matthieu approved the budget.
 *   SOAK_RSS_MB      allowed router RSS growth, default 40
 *   SOAK_DOCKER      1 = also count `jobwatch.managed` containers with the docker CLI (needs the socket in this container)
 * Exit code 0 = green, 1 = a check failed, 2 = could not run.
 */
import { spawnSync } from 'node:child_process';

const env = process.env;
const url = env['SOAK_URL'] ?? 'http://router:8080/mcp';
const secret = env['SOAK_SECRET'] ?? '';
const durationS = env['SOAK_SECONDS'] ? Number(env['SOAK_SECONDS']) : Number(env['SOAK_HOURS'] ?? '6') * 3600;
const minS = Number(env['SOAK_MIN_S'] ?? '300');
const maxS = Number(env['SOAK_MAX_S'] ?? '1200');
const rssBudgetMb = Number(env['SOAK_RSS_MB'] ?? '40');
const countContainers = env['SOAK_DOCKER'] === '1';
const calls = (env['SOAK_CALLS'] ?? 'memory_report')
  .split(';')
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '')
  .map((entry) => {
    const at = entry.indexOf('=');
    return at === -1 ? { tool: entry, args: {} } : { tool: entry.slice(0, at), args: JSON.parse(entry.slice(at + 1)) as unknown };
  });

if (![durationS, minS, maxS, rssBudgetMb].every(Number.isFinite) || minS > maxS || calls.length === 0) {
  console.error('soak: invalid settings');
  process.exit(2);
}

let nextId = 1;
async function rpc(method: string, params: unknown): Promise<{ result?: any; error?: { code: number; message: string } }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  const body = response.headers.get('content-type')?.includes('text/event-stream')
    ? (text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5) ?? '{}')
    : text;
  return JSON.parse(body);
}

interface Sample {
  at: string;
  rssMb: number | undefined;
  state: string | undefined;
  containers: number | undefined;
  failures: string[];
}

function managedContainers(): number | undefined {
  const result = spawnSync('docker', ['ps', '-aq', '--filter', 'label=jobwatch.managed=true'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean).length : undefined;
}

async function round(): Promise<Sample> {
  const failures: string[] = [];
  let rssMb: number | undefined;
  let state: string | undefined;
  for (const call of [{ tool: 'memory_report', args: {} }, ...calls.filter((c) => c.tool !== 'memory_report')]) {
    try {
      const { result, error } = await rpc('tools/call', { name: call.tool, arguments: call.args });
      if (error) failures.push(`${call.tool}: ${error.message}`);
      else if (result?.isError) failures.push(`${call.tool}: ${String(result.content?.[0]?.text ?? 'error').slice(0, 160)}`);
      else if (call.tool === 'memory_report') {
        const report = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}');
        rssMb = report.process?.rss_mb;
        state = report.runtime?.state;
      }
    } catch (error) {
      failures.push(`${call.tool}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { at: new Date().toISOString(), rssMb, state, containers: countContainers ? managedContainers() : undefined, failures };
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`soak: ${calls.map((c) => c.tool).join(', ')} against ${url} for ${Math.round(durationS / 60)} min`);
const samples: Sample[] = [];
const end = Date.now() + durationS * 1000;
do {
  const sample = await round();
  samples.push(sample);
  console.log(
    `${sample.at} rss=${sample.rssMb ?? '?'}MB runtime=${sample.state ?? '?'}` +
      `${sample.containers === undefined ? '' : ` containers=${sample.containers}`}` +
      `${sample.failures.length ? ` FAILURES: ${sample.failures.join(' | ')}` : ''}`,
  );
  const pause = (minS + Math.random() * (maxS - minS)) * 1000;
  if (Date.now() + pause < end) await sleep(pause);
  else break;
} while (Date.now() < end);

const problems: string[] = [];
const failed = samples.filter((sample) => sample.failures.length > 0).length;
if (failed > 0) problems.push(`${failed} of ${samples.length} rounds had failing calls`);
const rss = samples.flatMap((sample) => (sample.rssMb === undefined ? [] : [sample.rssMb]));
if (rss.length < 4) problems.push('too few memory_report samples to judge RSS growth (need at least 4 rounds)');
else {
  const growth = median(rss.slice(-3)) - median(rss.slice(0, 3));
  console.log(
    `soak: router RSS median first 3 = ${median(rss.slice(0, 3))} MB, last 3 = ${median(rss.slice(-3))} MB (growth ${growth.toFixed(1)} MB, budget ${rssBudgetMb})`,
  );
  if (growth > rssBudgetMb) problems.push(`router RSS grew by ${growth.toFixed(1)} MB (budget ${rssBudgetMb})`);
}
const crowded = samples.filter((sample) => (sample.containers ?? 0) > 1);
if (crowded.length > 0) problems.push(`${crowded.length} round(s) saw more than one managed browser container`);
console.log(problems.length === 0 ? 'soak: GREEN' : `soak: RED\n - ${problems.join('\n - ')}`);
process.exit(problems.length === 0 ? 0 : 1);

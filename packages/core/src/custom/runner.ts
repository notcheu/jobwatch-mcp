/**
 * The program that runs an operator's script, as the text of an ES module given to `node --permission ... -e`. It runs in a process the
 * router starts for ONE call: in a container with no network, no capability, a read-only root and no environment (the default), or,
 * for local development only, in a bare Node process with the permission model (no files, no network, no child process, no worker; no container).
 *
 * It has nothing of its own: no secret, no file, no connection. Everything the script can do goes through `rpc` lines on stdout that the
 * router answers (or refuses) on stdin, so the router's checks (host allowlist, metering, caps) apply to every request. The script is
 * not trusted and can write anything on stdout; the router validates every line and treats the process as the only boundary.
 */
export const RUNNER_SOURCE = String.raw`
import { createInterface } from 'node:readline';

const send = (message) => new Promise((resolve) => process.stdout.write(JSON.stringify(message) + '\n', resolve));
const pending = new Map();
let nextId = 1;
const call = (fn, args) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ type: 'rpc', id, fn, args });
  });
const response = (reply) => ({
  status: reply.status,
  ok: reply.ok,
  headers: reply.headers,
  text: reply.text,
  json() {
    return JSON.parse(reply.text);
  },
});

async function run(job) {
  const globals = {
    http: {
      get: async (url, options) => response(await call('http.get', [url, options ?? {}])),
      postJson: async (url, body, options) => response(await call('http.postJson', [url, body, options ?? {}])),
    },
    htmlToText: (html) => call('sdk.htmlToText', [html]),
    slugify: (text) => call('sdk.slugify', [text]),
    titleCase: (text) => call('sdk.titleCase', [text]),
    log: (...parts) => call('log', [parts.map(String).join(' ')]),
  };
  if (job.kind === 'browser') {
    globals.session = {
      goto: (url, options) => call('session.goto', [url, options ?? {}]),
      evaluate: (script, arg) => call('session.evaluate', [script, arg]),
      waitForSelector: (selector, timeoutMs) => call('session.waitForSelector', [selector, timeoutMs]),
      text: (selector) => call('session.text', [selector]),
      url: () => call('session.url', []),
    };
  }
  const names = Object.keys(globals);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const factory = new AsyncFunction(...names, job.script + '\nreturn typeof read === "function" ? read : undefined;');
  const read = await factory(...names.map((name) => globals[name]));
  if (read === undefined) throw new Error('The script defines no function named read.');
  return await read(job.board, job.filters);
}

let started = false;
createInterface({ input: process.stdin }).on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === 'reply') {
    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(new Error(String(message.error)));
    return;
  }
  if (message.type !== 'run' || started) return;
  started = true;
  try {
    await send({ type: 'result', value: await run(message) });
  } catch (error) {
    await send({ type: 'error', message: String((error && error.message) || error).slice(0, 500) });
  }
  process.exit(0);
});
`;

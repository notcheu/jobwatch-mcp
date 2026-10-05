// The environment of a local run (`npm run dev`, `npm run start`): the variables of the env files, then of the shell, over the defaults.
// DATA_DIR defaults to ./.data (created here); set it in an env file or in the shell to use another folder.
import { mkdirSync } from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const DEFAULT_DATA_DIR = './.data';

/** `files`: env files in increasing priority; a missing one is skipped. Returns the env for the server and creates its data folder. */
export function localEnv(files) {
  const fromFiles = {};
  for (const file of files) if (existsSync(file)) Object.assign(fromFiles, parseEnv(readFileSync(file, 'utf8')));
  const env = { DATA_DIR: DEFAULT_DATA_DIR, ...fromFiles, ...process.env };
  if (env.DATA_DIR === '') env.DATA_DIR = DEFAULT_DATA_DIR; // an empty value means "not set", as for the server
  mkdirSync(resolve(env.DATA_DIR), { recursive: true });
  return env;
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { browserAdapter, greetingTool, httpAdapter, titleTool } from '../__fixtures__/adapters';
import { writeCatalogSnapshot } from '../catalog-fs';
import { describeAdapterContract } from './contract';
import { createBrowserTestContext, createHttpTestContext } from './fakes';

// Dogfooding: the contract runner passes for the two fixture adapters when their snapshots are in sync.
// (Its failure paths are covered by validate.test.ts and catalog-fs.test.ts, which test the same functions.)
const dirs: Record<string, string> = {};
beforeAll(async () => {
  for (const adapter of [httpAdapter, browserAdapter]) {
    dirs[adapter.id] = await mkdtemp(join(tmpdir(), `jw-contract-${adapter.id}-`));
    await writeCatalogSnapshot(adapter, dirs[adapter.id] as string);
  }
});
afterAll(async () => {
  await Promise.all(Object.values(dirs).map((dir) => rm(dir, { recursive: true, force: true })));
});

// describeAdapterContract registers tests synchronously, so snapshotDir is resolved lazily through a getter-like proxy path.
describeAdapterContract(httpAdapter, {
  get snapshotDir() {
    return dirs[httpAdapter.id] as string;
  },
  samples: {
    echo_greeting: {
      args: { name: 'Ada' },
      run: (args) => {
        const { ctx } = createHttpTestContext({
          allowedHosts: httpAdapter.allowedHosts,
          routes: [{ url: 'https://api.example.com/hello?name=Ada', body: { message: 'Hello Ada' } }],
        });
        return greetingTool.handler(args, ctx);
      },
    },
  },
});

describeAdapterContract(browserAdapter, {
  get snapshotDir() {
    return dirs[browserAdapter.id] as string;
  },
  samples: {
    page_title: {
      args: {},
      run: (args) => {
        const { ctx } = createBrowserTestContext({
          allowedHosts: browserAdapter.allowedHosts,
          pages: { 'https://www.example.com/': { texts: { h1: 'Example' } } },
        });
        return titleTool.handler(args, ctx);
      },
    },
  },
});

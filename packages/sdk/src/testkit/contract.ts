import { describe, expect, it } from 'vitest';
import type { McpModule } from '../adapter';
import { stableStringify } from '../catalog';
import { diffCatalogSnapshot, writeCatalogSnapshot } from '../catalog-fs';
import { validateAdapter } from '../validate';

export interface ContractSample {
  /** Raw arguments, as a client would send them. */
  args: unknown;
  /** Runs the tool's handler with a fake context and returns what the handler returned. */
  run: (args: never) => Promise<{ data: unknown; warnings: string[] }>;
}

export interface ContractOptions {
  /** The adapter's committed `catalog/` folder. */
  snapshotDir: string;
  /**
   * Rewrite the snapshot instead of failing when it is out of date. Defaults to `JW_UPDATE_CATALOG=1` in the environment,
   * which is what `npm run catalog:gen` sets (like `vitest -u`). Never enable it in CI.
   */
  updateSnapshots?: boolean;
  /** Optional per-tool samples: each must produce output that matches the tool's `output` schema within `outputMaxBytes`. */
  samples?: Readonly<Record<string, ContractSample>>;
}

/**
 * The contract test every adapter package runs (docs/plans/11-testing-and-validation.md). Call it from a `*.test.ts` file:
 * `describeAdapterContract(adapter, { snapshotDir: new URL('../catalog', import.meta.url).pathname })`.
 */
export function describeAdapterContract(adapter: McpModule, options: ContractOptions): void {
  describe(`adapter contract: ${adapter.id}`, () => {
    it('satisfies the startup rules', () => {
      expect(validateAdapter(adapter)).toEqual([]);
    });

    it('has a catalog snapshot in sync with its definitions (run `npm run catalog:gen` to update)', async () => {
      if (options.updateSnapshots ?? process.env['JW_UPDATE_CATALOG'] === '1') await writeCatalogSnapshot(adapter, options.snapshotDir);
      expect(await diffCatalogSnapshot(adapter, options.snapshotDir)).toEqual({ missing: [], stale: [], changed: [] });
    });

    for (const tool of adapter.tools) {
      const sample = options.samples?.[tool.name];
      if (!sample) continue;
      it(`${tool.name}: sample output matches the output schema and the size cap`, async () => {
        const parsedArgs: unknown = tool.input.parse(sample.args);
        const result = await sample.run(parsedArgs as never);
        const parsedOutput: unknown = tool.output.parse(result.data);
        expect(Buffer.byteLength(stableStringify(parsedOutput))).toBeLessThanOrEqual(tool.limits.outputMaxBytes);
      });
    }
  });
}

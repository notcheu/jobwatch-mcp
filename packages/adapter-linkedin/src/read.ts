import {
  readByIds as sdkReadByIds,
  readNew as sdkReadNew,
  type BrowserAdapterContext,
  type ByIdOutcome,
  type ByIdPlan as SdkByIdPlan,
  type ReadOutcome,
  type ReadPlan as SdkReadPlan,
} from '@jobwatch/sdk';
import type { Card } from './parse';
import { readJob } from './search';

/**
 * The visiting strategy (skip ids, then the title, then the stored copy, then a visit that stores before it judges) is shared by
 * every platform with search cards, and lives in the SDK (`visit.ts`, `07-adapter-linkedin.md` describes the rules). This file
 * only says how LinkedIn reads one job: by navigating to its page.
 */
export type { AcceptedJob, ByIdOutcome, Excluded, ExcludedBy, Failed, ReadOutcome, Terms } from '@jobwatch/sdk';

export type ReadPlan = Omit<SdkReadPlan, 'visit' | 'board'>;
export type ByIdPlan = Omit<SdkByIdPlan, 'visit' | 'board'>;

export function readNew(ctx: BrowserAdapterContext, cards: readonly Card[], plan: ReadPlan): Promise<ReadOutcome> {
  return sdkReadNew(ctx.jobs, cards, { ...plan, visit: (id) => readJob(ctx, id) });
}

export function readByIds(ctx: BrowserAdapterContext, ids: readonly string[], plan: ByIdPlan): Promise<ByIdOutcome> {
  return sdkReadByIds(ctx.jobs, ids, { ...plan, visit: (id) => readJob(ctx, id) });
}

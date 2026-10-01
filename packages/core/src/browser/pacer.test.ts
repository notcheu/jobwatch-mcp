import { describe, expect, it } from 'vitest';
import { DEFAULT_BROWSER_PACING, NO_PACING, createPacer } from './pacer';

function harness(random: number) {
  let clock = 1_000_000;
  const slept: number[] = [];
  const pace = createPacer(DEFAULT_BROWSER_PACING, {
    random: () => random,
    now: () => clock,
    sleep: async (ms) => void (slept.push(ms), (clock += ms)),
  });
  return { pace, slept, advance: (ms: number) => (clock += ms) };
}

describe('createPacer', () => {
  it('defaults to 2.5 to 5 s for browsers and nothing for the null pacing', () => {
    expect(DEFAULT_BROWSER_PACING).toEqual({ minMs: 2500, maxMs: 5000 });
    expect(NO_PACING).toEqual({ minMs: 0, maxMs: 0 });
  });

  it('does not wait before the first load', async () => {
    const h = harness(0.5);
    await h.pace('page');
    expect(h.slept).toEqual([]);
  });

  it('waits a jittered time between loads, within the bounds', async () => {
    const low = harness(0);
    await low.pace('page');
    await low.pace('page');
    expect(low.slept).toEqual([2500]);
    const high = harness(0.999999);
    await high.pace('page');
    await high.pace('detail');
    expect(high.slept[0]).toBeGreaterThanOrEqual(4990);
    expect(high.slept[0]).toBeLessThanOrEqual(5000);
  });

  it('counts the time already spent: work between loads reduces the wait', async () => {
    const h = harness(0);
    await h.pace('page');
    h.advance(1000);
    await h.pace('page');
    expect(h.slept).toEqual([1500]);
  });

  it('does not wait at all when the gap is already long enough', async () => {
    const h = harness(0);
    await h.pace('page');
    h.advance(60_000);
    await h.pace('page');
    expect(h.slept).toEqual([]);
  });

  it('never waits with the null pacing', async () => {
    const slept: number[] = [];
    const pace = createPacer(NO_PACING, { sleep: async (ms) => void slept.push(ms) });
    await pace('page');
    await pace('page');
    expect(slept).toEqual([]);
  });
});

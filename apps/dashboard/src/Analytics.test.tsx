import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOW, me, mockApi, renderApp, tools } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

const usage = (over: Record<string, unknown> = {}) => ({
  scope: 'session',
  granularity: 'hour',
  since: NOW,
  totals: {
    calls: 10,
    errors: 2,
    responseBytes: 20_480,
    estimatedTokens: 5700,
    unitsSpent: 30,
    textAvailableChars: 80_000,
    textReturnedChars: 8000,
    durationP50Ms: 400,
    durationP95Ms: 2200,
    durationMaxMs: 4100,
  },
  byTool: [
    {
      tool: 'linkedin_search',
      platform: 'linkedin',
      calls: 6,
      errors: 1,
      estimatedTokens: 4200,
      avgTokens: 700,
      avgDurationMs: 1800,
      maxDurationMs: 4100,
      avgUnitsSpent: 4.5,
    },
    {
      tool: 'apec_search',
      platform: 'apec',
      calls: 4,
      errors: 1,
      estimatedTokens: 1500,
      avgTokens: 375,
      avgDurationMs: 900,
      maxDurationMs: 1200,
      avgUnitsSpent: 2,
    },
  ],
  series: [
    { bucket: '2026-10-09T10:00:00.000Z', calls: 4, errors: 1, estimatedTokens: 2000 },
    { bucket: '2026-10-09T11:00:00.000Z', calls: 6, errors: 1, estimatedTokens: 3700 },
  ],
  ...over,
});
const overview = {
  version: '1',
  uptimeS: 100,
  health: { completed: 8, failed: 1, rateLimited: 1, active: 0 },
  tokensReturned: 5700,
  callsInMemory: 10,
  callBufferSize: 2000,
  storedJobs: 321,
  runtimeState: 'cold',
  enabledAdapters: 2,
};
const adapters = {
  adapters: [
    {
      id: 'linkedin',
      displayName: 'LinkedIn',
      platform: 'linkedin',
      role: 'adapter',
      kind: 'browser',
      enabled: true,
      pinned: false,
      hosts: [],
      tools: [],
      rateHour: { used: 190, limit: 200 },
      rateDay: { used: 100, limit: 400 },
      boards: [],
      breaker: null,
      session: null,
    },
    {
      id: 'teamtailor',
      displayName: 'Teamtailor',
      platform: 'teamtailor',
      role: 'adapter',
      kind: 'http',
      enabled: true,
      pinned: false,
      hosts: [],
      tools: [],
      rateHour: { used: 4, limit: 600 },
      rateDay: { used: 40, limit: 3000 },
      boards: [
        { board: 'bsport', rateHour: { used: 19, limit: 20 }, rateDay: { used: 30, limit: 100 } },
        { board: 'quiet', rateHour: { used: 1, limit: 20 }, rateDay: { used: 2, limit: 100 } },
      ],
      breaker: null,
      session: null,
    },
  ],
  runtime: tools.runtime,
};
const searches = {
  searches: [
    { source: 'linkedin', query: 'react engineer', runs: 4, lastRun: NOW, jobsFound: 80, jobsReturned: 30, jobsNew: 20 },
    { source: 'linkedin', query: 'vue', runs: 3, lastRun: NOW, jobsFound: 10, jobsReturned: 0, jobsNew: 0 },
    { source: 'wttj', query: '', runs: 1, lastRun: NOW, jobsFound: 12, jobsReturned: 12, jobsNew: 12 },
  ],
};
const common = { '/me': me, '/tools': adapters, '/overview': overview, '/searches': searches };

describe('analytics', () => {
  it('shows the health, the headline numbers, the durations and the token usage of the session', async () => {
    mockApi({ ...common, '/usage': usage() });
    renderApp('/analytics');
    expect(await screen.findByText('~5.7k')).toBeInTheDocument();
    expect(screen.getByText('~570 per call · 20.0 KB sent')).toBeInTheDocument();
    expect(screen.getByText('2 failed or refused (20 %)')).toBeInTheDocument();
    expect(screen.getByText('90 %')).toBeInTheDocument(); // 8,000 of 80,000 characters sent: 90 % kept back
    expect(screen.getByText('400 ms')).toBeInTheDocument();
    expect(screen.getByText('2.2 s')).toBeInTheDocument();
    expect(screen.getByText('Request health')).toBeInTheDocument();
    expect(screen.getByText('Live activity')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Estimated tokens returned per hour/ })).toBeInTheDocument();
  });

  it('lists each tool with its calls, errors, tokens, durations and share of the tokens', async () => {
    mockApi({ ...common, '/usage': usage() });
    renderApp('/analytics');
    await screen.findByText('Per tool');
    const row = within(screen.getByText('linkedin_search', { selector: 'td' }).closest('tr') as HTMLElement);
    expect(row.getByText('4.2k')).toBeInTheDocument();
    expect(row.getByText('74 %')).toBeInTheDocument(); // 4200 of 5700
    expect(row.getByText('1.8 s')).toBeInTheDocument();
    expect(row.getByText('4.5')).toBeInTheDocument();
  });

  it('switches to the lifetime totals, which have no percentiles, and says so', async () => {
    const seen = mockApi({
      ...common,
      '/usage': (url: URL) =>
        url.searchParams.get('scope') === 'lifetime'
          ? usage({
              scope: 'lifetime',
              granularity: 'day',
              totals: { ...usage().totals, durationP50Ms: null, durationP95Ms: null },
              series: [{ bucket: '2026-10-08T00:00:00.000Z', calls: 10, errors: 2, estimatedTokens: 5700 }],
            })
          : usage(),
    });
    renderApp('/analytics');
    const user = userEvent.setup();
    await screen.findByText('~5.7k');
    await user.click(screen.getByRole('button', { name: 'Lifetime' }));
    expect(await screen.findByText(/Percentiles need every call/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /per day/ })).toBeInTheDocument();
    expect(seen.some((url) => url.startsWith('/dashboard/api/v1/usage') && url.includes('scope=lifetime'))).toBe(true);
  });

  it('asks for the dates picked in the historical view', async () => {
    const seen = mockApi({ ...common, '/usage': usage({ scope: 'historical', granularity: 'day' }) });
    renderApp('/analytics');
    const user = userEvent.setup();
    await screen.findByText('~5.7k');
    await user.click(screen.getByRole('button', { name: 'Historical' }));
    await user.type(screen.getByLabelText('From date'), '2026-10-01');
    await user.type(screen.getByLabelText('To date'), '2026-10-07');
    await waitFor(() =>
      expect(seen.some((url) => url.includes('scope=historical') && url.includes('from=2026-10-01') && url.includes('to=2026-10-07'))).toBe(
        true,
      ),
    );
  });

  it('filters to the selected tool tab', async () => {
    const seen = mockApi({ ...common, '/usage': usage() });
    renderApp('/analytics?tool=linkedin');
    await screen.findByText('~5.7k');
    expect(seen.some((url) => url.startsWith('/dashboard/api/v1/usage') && url.includes('platform=linkedin'))).toBe(true);
  });

  it('says what to do when nothing was called yet', async () => {
    mockApi({
      ...common,
      '/usage': usage({
        totals: { ...usage().totals, calls: 0, errors: 0, durationP50Ms: null, durationP95Ms: null, durationMaxMs: null },
        byTool: [],
        series: [],
      }),
    });
    renderApp('/analytics');
    expect(await screen.findByText(/No calls yet\. Run a search from Claude/)).toBeInTheDocument();
  });

  it('shows the budgets, colours the near-full ones, and lists the company boards closest to their limit', async () => {
    mockApi({ ...common, '/usage': usage() });
    renderApp('/analytics');
    const budgets = await screen.findByLabelText('Budgets');
    expect(within(budgets).getByText('190 / 200')).toBeInTheDocument();
    expect(within(budgets).getByText('teamtailor/bsport')).toBeInTheDocument();
    expect(within(budgets).getByText('95 %')).toBeInTheDocument();
    expect(within(budgets).queryByText('teamtailor/quiet')).not.toBeInTheDocument(); // under half of its limit
  });

  it('points at the keywords that bring new jobs and at the ones that found nothing new', async () => {
    mockApi({ ...common, '/usage': usage(), '/jobs': { jobs: [], total: 0, page: 1, pageSize: 25 } });
    renderApp('/analytics');
    const best = await screen.findByLabelText('Best keywords');
    expect(within(best).getByText('20 new of 80')).toBeInTheDocument();
    expect(within(best).queryByText(/12 new/)).not.toBeInTheDocument(); // a search without keywords is not a keyword
    const stale = screen.getByLabelText('Keywords to drop');
    expect(within(stale).getByText(/3 runs/)).toBeInTheDocument();
    expect(within(stale).getByText('vue', { exact: false })).toBeInTheDocument();
    await userEvent.setup().click(within(best).getByRole('button', { name: /react engineer/ }));
    expect(await screen.findByLabelText('Found by keyword')).toHaveValue('react engineer');
  });

  it('keeps every number marked as an estimate', async () => {
    mockApi({ ...common, '/usage': usage() });
    renderApp('/analytics');
    expect(await screen.findByText(/Token counts are estimates \(~\)/)).toBeInTheDocument();
  });
});

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { me, mockApi, renderApp, tools } from './test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

const settings = {
  signIn: 'google',
  idleStopMinutes: 30,
  sessionMaxHours: 8,
  writeWindowMinutes: 10,
  callBuffer: 2000,
  charsPerToken: 3.5,
  jobRetentionDays: 30,
  callLogRetentionDays: 14,
  maxTabs: 3,
  browser: { idleStopSeconds: 120, memoryHighMb: 1200, memoryMaxMb: 1500 },
  adaptersPinned: false,
};

describe('settings tabs', () => {
  it('has the settings and Tools & status as two tabs, and /tools leads to the second', async () => {
    mockApi({ '/me': me, '/tools': tools, '/settings': settings });
    renderApp('/settings');
    const user = userEvent.setup();
    const list = await screen.findByRole('tablist', { name: 'Settings' });
    expect(list.textContent).toBe('SettingsTools & status');
    await user.click(screen.getByRole('tab', { name: 'Tools & status' }));
    expect(await screen.findByText('LinkedIn')).toBeInTheDocument();
    expect(screen.queryByText('Limits in force (read only)')).not.toBeInTheDocument();
  });

  it('sends the old /tools address to the Tools & status tab', async () => {
    mockApi({ '/me': me, '/tools': tools, '/settings': settings });
    renderApp('/tools');
    expect(await screen.findByRole('tab', { name: 'Tools & status', selected: true })).toBeInTheDocument();
  });
});

describe('settings', () => {
  it('shows the limits in force, read only, with what each one means', async () => {
    mockApi({ '/me': me, '/tools': tools, '/settings': settings });
    renderApp('/settings');
    expect(await screen.findByText('Limits in force (read only)')).toBeInTheDocument();
    expect(await screen.findByText('30 min')).toBeInTheDocument();
    expect(screen.getByText('8 h')).toBeInTheDocument();
    expect(screen.getByText('10 min')).toBeInTheDocument();
    expect(screen.getByText('2000')).toBeInTheDocument();
    expect(screen.getByText('14 days')).toBeInTheDocument(); // how long a call is kept in the call log
    expect(screen.getByText('Calls are kept')).toBeInTheDocument();
    expect(screen.getByText('1200 / 1500 MB')).toBeInTheDocument();
    expect(screen.getByText('Google')).toBeInTheDocument();
    expect(screen.getByText('editable')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); // nothing here can be edited
  });

  it('says in local development that there is no sign-in, and when the list of adapters is pinned', async () => {
    mockApi({ '/me': me, '/tools': tools, '/settings': { ...settings, signIn: 'none', adaptersPinned: true } });
    renderApp('/settings');
    expect(await screen.findByText('none')).toBeInTheDocument();
    expect(screen.getByText('pinned')).toBeInTheDocument();
  });

  it('switches the theme and remembers it in this browser', async () => {
    mockApi({ '/me': me, '/tools': tools, '/settings': settings });
    renderApp('/settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Dark: switch to light/ }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('jw-theme')).toBe('light');
    expect(screen.getByRole('button', { name: /Light: switch to dark/ })).toBeInTheDocument();
  });

  it('shows an error when the settings cannot be loaded', async () => {
    mockApi({ '/me': me, '/tools': tools });
    renderApp('/settings');
    expect(await screen.findByText('Could not load the settings.')).toBeInTheDocument();
  });
});

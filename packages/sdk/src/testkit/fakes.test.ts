import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { browserAdapter, greetingTool, httpAdapter, titleTool } from '../__fixtures__/adapters';
import { AdapterBroken, HostNotAllowedError } from '../errors';
import { createBrowserTestContext, createHttpTestContext, FakeBrowserSession, FakeHttpClient } from './fakes';

describe('FakeBrowserSession', () => {
  it('enforces the host allowlist like the real session', async () => {
    const session = new FakeBrowserSession(['www.example.com']);
    await expect(session.goto('https://evil.example/', { timeoutMs: 100 })).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(session.goto('http://www.example.com/', { timeoutMs: 100 })).rejects.toBeInstanceOf(HostNotAllowedError);
    expect(session.visited).toEqual([]);
  });

  it('records navigations without query strings and serves canned pages', async () => {
    const session = new FakeBrowserSession(['www.example.com'], {
      'https://www.example.com/jobs': { present: ['#list'], texts: { h1: 'Jobs' }, evaluate: (_script, arg) => ({ echoed: arg }) },
    });
    await session.goto('https://www.example.com/jobs?token=SECRET', { timeoutMs: 100 });
    expect(session.visited).toEqual(['https://www.example.com/jobs']);
    expect(session.url()).toBe('https://www.example.com/jobs?token=SECRET');
    expect(await session.text('h1')).toBe('Jobs');
    expect(await session.text('h2')).toBeNull();
    expect(await session.waitForSelector('#list', 10)).toBe(true);
    expect(await session.waitForSelector('h1', 10)).toBe(true);
    expect(await session.waitForSelector('#missing', 10)).toBe(false);
    expect(await session.evaluate('1+1', 7)).toEqual({ echoed: 7 });
  });

  it('fails loudly when a page has no evaluate handler', async () => {
    const session = new FakeBrowserSession(['www.example.com']);
    await session.goto('https://www.example.com/', { timeoutMs: 100 });
    await expect(session.evaluate('1')).rejects.toThrow(/no evaluate handler/);
  });
});

describe('FakeHttpClient', () => {
  const routes = [
    { url: 'https://api.example.com/hello?name=Ada', body: { message: 'Hello Ada' } },
    { method: 'POST' as const, url: /\/search$/, body: { hits: [] } },
  ];

  it('serves routes, records redacted requests and validates JSON with the schema', async () => {
    const http = new FakeHttpClient(['api.example.com'], routes);
    const response = await http.get('https://api.example.com/hello?name=Ada');
    expect(response.ok).toBe(true);
    expect(response.json(z.object({ message: z.string() }))).toEqual({ message: 'Hello Ada' });
    await http.postJson('https://api.example.com/search', { q: 'x' });
    expect(http.requests).toEqual([
      { method: 'GET', url: 'https://api.example.com/hello' },
      { method: 'POST', url: 'https://api.example.com/search', body: { q: 'x' } },
    ]);
  });

  it('turns a changed response shape into AdapterBroken, never an empty result', async () => {
    const http = new FakeHttpClient(['api.example.com'], routes);
    const response = await http.get('https://api.example.com/hello?name=Ada');
    expect(() => response.json(z.object({ greeting: z.string() }))).toThrow(AdapterBroken);
  });

  it('turns a non-JSON body into AdapterBroken', async () => {
    const http = new FakeHttpClient(['api.example.com'], [{ url: 'https://api.example.com/x', body: '<html>blocked</html>' }]);
    await expect(http.get('https://api.example.com/x').then((r) => r.json(z.unknown()))).rejects.toBeInstanceOf(AdapterBroken);
  });

  it('enforces the allowlist and rejects unknown routes', async () => {
    const http = new FakeHttpClient(['api.example.com'], routes);
    await expect(http.get('https://evil.example/hello')).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(http.get('https://api.example.com/unknown')).rejects.toThrow(/no route/);
  });

  it('reports non-2xx statuses as not ok', async () => {
    const http = new FakeHttpClient(['api.example.com'], [{ url: 'https://api.example.com/x', status: 503, body: 'down' }]);
    const response = await http.get('https://api.example.com/x');
    expect(response.ok).toBe(false);
    expect(response.status).toBe(503);
  });
});

describe('test contexts run real handlers', () => {
  it('runs an HTTP tool end to end', async () => {
    const { ctx, http } = createHttpTestContext({
      allowedHosts: httpAdapter.allowedHosts,
      routes: [{ url: 'https://api.example.com/hello?name=Ada', body: { message: 'Hello Ada' } }],
    });
    const result = await greetingTool.handler({ name: 'Ada', tags: [] }, ctx);
    expect(result).toEqual({ data: { greeting: 'Hello Ada' }, warnings: [] });
    expect(http.requests).toHaveLength(1);
  });

  it('runs a browser tool end to end and captures logs', async () => {
    const { ctx, logs, session } = createBrowserTestContext({
      allowedHosts: browserAdapter.allowedHosts,
      pages: { 'https://www.example.com/': { texts: { h1: 'Example Domain' } } },
    });
    const result = await titleTool.handler({}, ctx);
    expect(result.data).toEqual({ title: 'Example Domain' });
    expect(session.visited).toEqual(['https://www.example.com/']);
    expect(logs).toEqual([{ level: 'info', message: 'read title' }]);
  });

  it('runs the adapter session check', async () => {
    const loggedOut = createBrowserTestContext({
      allowedHosts: browserAdapter.allowedHosts,
      pages: { 'https://www.example.com/': { present: ['#login-form'] } },
    });
    const loggedIn = createBrowserTestContext({ allowedHosts: browserAdapter.allowedHosts, pages: { 'https://www.example.com/': {} } });
    expect(await browserAdapter.sessionCheck?.(loggedOut.session)).toEqual({ state: 'needs_login' });
    expect(await browserAdapter.sessionCheck?.(loggedIn.session)).toEqual({ state: 'ok' });
  });

  it('records pacing calls', async () => {
    const { ctx, paced } = createHttpTestContext({ allowedHosts: [] });
    await ctx.pace('page');
    await ctx.pace('detail');
    expect(paced).toEqual(['page', 'detail']);
  });
});

describe('FakeBrowserSession tabs', () => {
  it("refuses to open a tab unless maxTabs allows it, counts the extra tab's page loads, and stops at the limit", async () => {
    const off = createBrowserTestContext({ allowedHosts: ['www.example.com'] });
    await expect(off.session.openTab()).rejects.toThrow('Multi-tab is off');

    const on = createBrowserTestContext({ allowedHosts: ['www.example.com'], maxTabs: 2 });
    const tab = await on.session.openTab();
    await tab.goto('https://www.example.com/a', { timeoutMs: 1000 });
    expect(on.spent()).toBe(1);
    expect(tab.url()).toBe('https://www.example.com/a');
    await expect(on.session.openTab()).rejects.toThrow('At most 2 tabs');
    await tab.close();
    await expect(on.session.openTab()).resolves.toBeDefined();
  });
});

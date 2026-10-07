import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOW, me, mockApi, renderApp, tools } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

const adapter = (over: Record<string, unknown> = {}) => ({
  handle: 'acmejobs',
  id: 'custom-acmejobs',
  tool: 'custom_acmejobs',
  name: 'Acme jobs',
  kind: 'http',
  url: 'https://careers.acme.com',
  host: 'careers.acme.com',
  enabled: false,
  problem: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const list = (items: unknown[], over: Record<string, unknown> = {}) => ({ available: true, sandbox: 'docker', items, ...over });
const detail = (over: Record<string, unknown> = {}) => ({
  ...adapter(),
  script: 'async function read(board) {\n  return { postings: [] };\n}',
  events: [{ at: NOW, actor: 'me@example.com', action: 'created', sha256: 'a'.repeat(64) }],
  ...over,
});
const sample = (kind: string) => ({ kind, script: `// sample for ${kind}\nasync function read(board, filters) {\n  // TODO\n}` });
const common = { '/me': me, '/tools': tools };
const routes = (extra: Record<string, unknown> = {}) => ({
  ...common,
  '/custom-adapters/sample/http': sample('http'),
  '/custom-adapters/sample/browser': sample('browser'),
  ...extra,
});

describe('custom adapters page', () => {
  it('lists the adapters with their tool, context, host and a switch, under the Tools menu item', async () => {
    mockApi(
      routes({
        '/custom-adapters': list([
          adapter(),
          adapter({ handle: 'shop', name: 'Shop', kind: 'browser', tool: 'custom_shop', host: 'shop.example.com', enabled: true }),
        ]),
      }),
    );
    renderApp('/custom-adapters');
    const row = (await screen.findByText('Acme jobs')).closest('tr') as HTMLElement;
    expect(within(row).getByText('custom_acmejobs')).toBeInTheDocument();
    expect(within(row).getByText('HTTP')).toBeInTheDocument();
    expect(within(row).getByText('careers.acme.com')).toBeInTheDocument();
    expect(within(row).getByRole('switch', { name: 'Acme jobs on' })).toHaveAttribute('aria-checked', 'false');
    expect(within(screen.getByText('Shop').closest('tr') as HTMLElement).getByText('Browser')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(nav).getByRole('link', { name: 'Custom adapters' })).toBeInTheDocument();
  });

  it('says when the feature is off, and offers nothing to change', async () => {
    mockApi(routes({ '/custom-adapters': list([adapter()], { available: false }) }));
    renderApp('/custom-adapters');
    expect(await screen.findByRole('note')).toHaveTextContent('CUSTOM_ADAPTERS=on');
    expect(screen.getByRole('button', { name: /Create adapter/ })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Acme jobs on' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Acme jobs' })).toBeDisabled();
  });

  it('warns that the bare-process sandbox is not a container, and shows why an enabled adapter is not loaded', async () => {
    mockApi(
      routes({ '/custom-adapters': list([adapter({ enabled: true, problem: 'The address must be https.' })], { sandbox: 'process' }) }),
    );
    renderApp('/custom-adapters');
    expect(await screen.findByRole('alert')).toHaveTextContent('no container');
    expect(screen.getByText('Not loaded: The address must be https.')).toBeInTheDocument();
  });

  it('opens a form that starts from the sample of the context, swaps it when the context changes while it is untouched, and keeps what was typed', async () => {
    const user = userEvent.setup();
    mockApi(routes({ '/custom-adapters': list([]) }));
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('button', { name: /Create adapter/ }));
    const dialog = await screen.findByRole('dialog');
    const script = within(dialog).getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
    await waitFor(() => expect(script.value).toContain('sample for http'));
    await user.selectOptions(within(dialog).getByLabelText('Context'), 'browser');
    await waitFor(() => expect(script.value).toContain('sample for browser'));
    await user.type(script, ' // mine');
    await user.selectOptions(within(dialog).getByLabelText('Context'), 'http');
    await waitFor(() => expect(within(dialog).getByLabelText('Context')).toHaveValue('http'));
    expect(script.value).toContain('// mine'); // typed over: no longer replaced
    expect(script.value).toContain('sample for browser');
  });

  it('indents with Tab and keeps the indentation on Enter in the editor', async () => {
    const user = userEvent.setup();
    mockApi(routes({ '/custom-adapters': list([]) }));
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('button', { name: /Create adapter/ }));
    const script = (await screen.findByRole('textbox', { name: 'Script' })) as HTMLTextAreaElement;
    fireEvent.change(script, { target: { value: 'if (a) {' } });
    fireEvent.keyDown(script, { key: 'Enter' });
    await waitFor(() => expect(script.value).toBe('if (a) {\n  '));
    fireEvent.keyDown(script, { key: 'Tab' });
    await waitFor(() => expect(script.value).toBe('if (a) {\n    '));
  });

  it('creates an adapter with the handle, the context, the address and the script, only when they are valid', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    mockApi(routes({ '/custom-adapters': list([]) }));
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)));
        return Promise.resolve(new Response(JSON.stringify(detail()), { status: 201 }));
      }
      return real(input, init);
    });
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('button', { name: /Create adapter/ }));
    const dialog = await screen.findByRole('dialog');
    const create = within(dialog).getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Name'), 'Acme jobs');
    await user.type(within(dialog).getByLabelText('Handle'), 'Bad-Handle!');
    expect(create).toBeDisabled(); // not a handle
    await user.clear(within(dialog).getByLabelText('Handle'));
    await user.type(within(dialog).getByLabelText('Handle'), 'acmejobs');
    await user.clear(within(dialog).getByLabelText('URL target'));
    await user.type(within(dialog).getByLabelText('URL target'), 'http://careers.acme.com');
    expect(create).toBeDisabled(); // not https
    await user.clear(within(dialog).getByLabelText('URL target'));
    await user.type(within(dialog).getByLabelText('URL target'), 'https://careers.acme.com');
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ handle: 'acmejobs', name: 'Acme jobs', kind: 'http', url: 'https://careers.acme.com' });
    expect((sent[0] as { script: string }).script).toContain('sample for http');
    expect(await screen.findByRole('status')).toHaveTextContent('Acme jobs created');
  });

  it('edits one: loads its script and history, keeps the handle, and sends the change as an update', async () => {
    const user = userEvent.setup();
    const sent: { method: string; url: string; body: unknown }[] = [];
    mockApi(routes({ '/custom-adapters': list([adapter({ enabled: true })]), '/custom-adapters/acmejobs': detail({ enabled: true }) }));
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        sent.push({ method: 'PUT', url: String(input), body: JSON.parse(String(init.body)) });
        return Promise.resolve(new Response(JSON.stringify(detail({ enabled: true })), { status: 200 }));
      }
      return real(input, init);
    });
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('button', { name: 'Edit Acme jobs' }));
    const dialog = await screen.findByRole('dialog');
    const script = within(dialog).getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
    await waitFor(() => expect(script.value).toContain('async function read(board)'));
    expect(within(dialog).getByLabelText('Handle')).toBeDisabled();
    expect(within(dialog).getByText('History (1)')).toBeInTheDocument();
    await user.type(script, '\n// changed');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.url).toContain('/custom-adapters/acmejobs');
    expect(sent[0]?.body).toMatchObject({ name: 'Acme jobs', kind: 'http', url: 'https://careers.acme.com' });
    expect((sent[0]?.body as { script: string }).script).toContain('// changed');
    expect(await screen.findByRole('status')).toHaveTextContent('The new script applies to the next call');
  });

  it('turns one on, and asks before it deletes one', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    mockApi(routes({ '/custom-adapters': list([adapter()]) }));
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        calls.push(`PUT ${new URL(String(input), 'http://x').pathname}`);
        return Promise.resolve(new Response(JSON.stringify(adapter({ enabled: true })), { status: 200 }));
      }
      if (init?.method === 'DELETE') {
        calls.push('DELETE');
        return Promise.resolve(new Response(JSON.stringify({ handle: 'acmejobs' }), { status: 200 }));
      }
      return real(input, init);
    });
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('switch', { name: 'Acme jobs on' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Acme jobs turned on. Reconnect the Claude connector');
    expect(calls).toEqual(['PUT /dashboard/api/v1/custom-adapters/acmejobs/enabled']);
    await user.click(screen.getByRole('button', { name: 'Delete Acme jobs' }));
    expect(calls).toHaveLength(1); // nothing yet
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls).toContain('DELETE'));
  });

  it("shows the router's refusal in the form, and asks for a new sign-in when the change needs one", async () => {
    const user = userEvent.setup();
    mockApi(routes({ '/custom-adapters': list([]) }));
    const real = globalThis.fetch;
    let answer: Response = new Response(JSON.stringify({ error: 'invalid', message: 'The host must be a public DNS name.' }), {
      status: 400,
    });
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST' ? Promise.resolve(answer.clone()) : real(input, init),
    );
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('button', { name: /Create adapter/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Acme');
    await user.type(within(dialog).getByLabelText('Handle'), 'acme');
    await user.type(within(dialog).getByLabelText('URL target'), 'careers.acme.com');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create' })).toBeEnabled());
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The host must be a public DNS name.');
    answer = new Response(JSON.stringify({ error: 'reauth_required', message: 'Sign in again.' }), { status: 401 });
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/Changes need a recent sign-in/)).toBeInTheDocument();
  });
});

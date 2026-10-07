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
const item = (name: string, over: Record<string, unknown> = {}) => ({ name, type: 'string', description: `What ${name} is for.`, ...over });
const docs = (kind: string) => [
  {
    id: 'globals',
    title: 'Globals',
    summary: 'Available in the script.',
    items: [item('http', { type: 'Http' }), ...(kind === 'browser' ? [item('session', { type: 'Session' })] : [])],
  },
  {
    id: 'posting',
    title: 'Posting',
    summary: 'One job you found.',
    items: [
      item('id', { description: 'Unique within this adapter. See `postings`.' }),
      item('postedAt', {
        type: 'string | null',
        fullType: "string | null // a date, '2026-10-01'",
        optional: true,
        description: 'When it was posted.',
      }),
    ],
  },
];
const sample = (kind: string) => ({
  kind,
  script: `// sample for ${kind}\nasync function read(board, filters) {\n  // TODO\n}`,
  docs: docs(kind),
});
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

  it('puts the settings on the left and the script on the right, and expands to nearly the whole window and back', async () => {
    const user = userEvent.setup();
    mockApi(routes({ '/custom-adapters': list([adapter()]), '/custom-adapters/acmejobs': detail() }));
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('button', { name: /Create adapter/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('data-expanded', 'false');
    // two columns: the settings in the first, the script in the second (one column on a narrow screen)
    const body = within(dialog).getByLabelText('Name').closest('.grid') as HTMLElement;
    expect(body.className).toContain('md:grid-cols-');
    const [settings, scriptColumn] = Array.from(body.children) as HTMLElement[];
    for (const label of ['Name', 'Handle', 'Context', 'URL target'])
      expect(within(settings as HTMLElement).getByLabelText(label)).toBeInTheDocument();
    expect(within(settings as HTMLElement).queryByRole('textbox', { name: 'Script' })).not.toBeInTheDocument();
    expect(within(scriptColumn as HTMLElement).getByRole('textbox', { name: 'Script' })).toBeInTheDocument();
    // the expand button is at the top, with the title, and the footer stays outside the scrolling body
    const expand = within(dialog).getByRole('button', { name: 'Expand the window' });
    expect(expand.parentElement?.textContent).toContain('Create a custom adapter');
    expect(body.contains(within(dialog).getByRole('button', { name: 'Create' }))).toBe(false);
    await user.click(expand);
    expect(dialog).toHaveAttribute('data-expanded', 'true');
    expect(dialog.className).toContain('h-[calc(100vh-2rem)]');
    expect(dialog.className).toContain('w-[calc(100vw-2rem)]');
    expect(within(dialog).getByRole('button', { name: 'Shrink the window' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(dialog).getByRole('button', { name: 'Shrink the window' }));
    expect(dialog).toHaveAttribute('data-expanded', 'false');
    expect(dialog.className).not.toContain('100vh-2rem');
    // a new opening starts small even after it was left expanded
    await user.click(within(dialog).getByRole('button', { name: 'Expand the window' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Edit Acme jobs' }));
    expect(await screen.findByRole('dialog')).toHaveAttribute('data-expanded', 'false');
  });

  it('hides the documentation until its icon button is pressed, between the script title and the editor, and hides it again', async () => {
    const user = userEvent.setup();
    mockApi(routes({ '/custom-adapters': list([]) }));
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('button', { name: /Create adapter/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('region', { name: 'Script documentation' })).not.toBeInTheDocument();
    const toggle = within(dialog).getByRole('button', { name: 'Show the documentation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    const region = await within(dialog).findByRole('region', { name: 'Script documentation' });
    expect(within(dialog).getByRole('button', { name: 'Hide the documentation' })).toHaveAttribute('aria-expanded', 'true');
    // the order in the column: the title and its button, then the documentation, then the editor
    const script = within(dialog).getByRole('textbox', { name: 'Script' });
    const title = within(dialog).getByText('Script', { selector: 'div' });
    expect(title.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region.compareDocumentPosition(script) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Hide the documentation' }));
    expect(within(dialog).queryByRole('region', { name: 'Script documentation' })).not.toBeInTheDocument();
    expect((script as HTMLTextAreaElement).value).toContain('sample for http'); // the script is untouched
  });

  it('shows one table for each object or type, with a row for each attribute, and the browser context adds the session', async () => {
    const user = userEvent.setup();
    mockApi(routes({ '/custom-adapters': list([]) }));
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('button', { name: /Create adapter/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Show the documentation' }));
    const region = await within(dialog).findByRole('region', { name: 'Script documentation' });
    expect(
      within(region)
        .getAllByRole('table')
        .map((table) => table.getAttribute('aria-label')),
    ).toEqual(['Globals', 'Posting']);
    const posting = within(region).getByRole('table', { name: 'Posting' });
    expect(
      within(posting)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Name', 'Type', 'Required']);
    const rows = within(posting).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('id')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Required')).toBeInTheDocument();
    expect(within(posting).getByText('Optional')).toBeInTheDocument();
    expect(within(region).queryByText('session')).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Context'), 'browser');
    expect(await within(dialog).findByText('session')).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: 'Script documentation' })).toBe(region); // the same panel: it did not close and reopen
  });

  it('opens a row into a description list of its name, description and type in full, and closes it again', async () => {
    const user = userEvent.setup();
    mockApi(routes({ '/custom-adapters': list([]) }));
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('button', { name: /Create adapter/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Show the documentation' }));
    const region = await within(dialog).findByRole('region', { name: 'Script documentation' });
    const row = within(region).getByRole('button', { name: 'postedAt in Posting' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(within(region).queryByText('When it was posted.')).not.toBeInTheDocument(); // a collapsed row shows no description
    await user.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const terms = within(region)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(terms).toEqual(['Name', 'Description', 'Type', 'Required']);
    expect(within(region).getByText('When it was posted.')).toBeInTheDocument();
    expect(within(region).getByText("string | null // a date, '2026-10-01'")).toBeInTheDocument(); // the type in full
    expect(within(region).getByText(/leave it out/)).toBeInTheDocument(); // optional
    await user.click(row);
    expect(within(region).queryByText('When it was posted.')).not.toBeInTheDocument();
    // rows open on their own: another stays as it is
    await user.click(within(region).getByRole('button', { name: 'id in Posting' }));
    await user.click(row);
    expect(within(region).getByText('When it was posted.')).toBeInTheDocument();
    expect(within(region).getByText(/Unique within this adapter/)).toBeInTheDocument();
    expect(within(region).getByText('postings', { selector: 'code' })).toBeInTheDocument(); // `backticks` are code
  });

  it('shows the reference of an adapter that is being edited too', async () => {
    const user = userEvent.setup();
    mockApi(routes({ '/custom-adapters': list([adapter()]), '/custom-adapters/acmejobs': detail() }));
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('button', { name: 'Edit Acme jobs' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Show the documentation' }));
    expect(await within(dialog).findByRole('table', { name: 'Posting' })).toBeInTheDocument();
    expect((within(dialog).getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement).value).toContain('async function read(board)'); // its own script, not the sample
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

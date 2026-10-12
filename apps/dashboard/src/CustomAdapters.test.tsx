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
  filters: [],
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
    id: 'filters',
    title: 'Filters',
    summary: 'The second argument of read.',
    items: [
      item('title_any', { type: 'string[]', description: 'Keywords of the title.' }),
      item('max_results', { type: 'number', description: 'The most jobs wanted.' }),
    ],
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

  it('is always the whole window: the settings, the script and the filters side by side, with no button to expand or shrink it', async () => {
    const user = userEvent.setup();
    mockApi(routes({ '/custom-adapters': list([adapter()]), '/custom-adapters/acmejobs': detail() }));
    renderApp('/custom-adapters');
    await user.click(await screen.findByRole('button', { name: /Create adapter/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.className).toContain('h-[calc(100vh-2rem)]');
    expect(dialog.className).toContain('w-[calc(100vw-2rem)]');
    expect(dialog).not.toHaveAttribute('data-expanded');
    expect(within(dialog).queryByRole('button', { name: /Expand the window|Shrink the window/ })).not.toBeInTheDocument();
    // three columns (one column on a narrow screen): the settings, then the script, then the filters
    const body = within(dialog).getByLabelText('Name').closest('.grid') as HTMLElement;
    expect(body.className).toContain('md:grid-cols-');
    expect(body.children).toHaveLength(3);
    const [settings, scriptColumn, filtersColumn] = Array.from(body.children) as HTMLElement[];
    for (const label of ['Name', 'Handle', 'Context', 'URL target'])
      expect(within(settings as HTMLElement).getByLabelText(label)).toBeInTheDocument();
    expect(within(settings as HTMLElement).queryByRole('textbox', { name: 'Script' })).not.toBeInTheDocument();
    expect(within(scriptColumn as HTMLElement).getByRole('textbox', { name: 'Script' })).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: 'Filters' })).toBe(filtersColumn);
    // the title is on its own at the top, and the footer stays outside the scrolling body
    expect(within(dialog).getByText('Create a custom adapter')).toBeInTheDocument();
    expect(body.contains(within(dialog).getByRole('button', { name: 'Create' }))).toBe(false);
    // and so is every opening, a new one or an edit
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Edit Acme jobs' }));
    expect((await screen.findByRole('dialog')).className).toContain('w-[calc(100vw-2rem)]');
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
    ).toEqual(['Globals', 'Filters', 'Posting']);
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

  describe('the filters column', () => {
    const open = async (user: ReturnType<typeof userEvent.setup>, extra: Record<string, unknown> = {}) => {
      mockApi(routes({ '/custom-adapters': list([adapter()]), '/custom-adapters/acmejobs': detail(), ...extra }));
      renderApp('/custom-adapters');
      await user.click(await screen.findByRole('button', { name: /Create adapter/ }));
      const dialog = await screen.findByRole('dialog');
      const column = within(dialog).getByRole('region', { name: 'Filters' });
      await within(column).findByLabelText('Key of built-in filter title_any');
      return { dialog, column };
    };

    it('lists the built-in filters from the router, locked, so they cannot be edited', async () => {
      const user = userEvent.setup();
      const { column } = await open(user);
      const builtin = within(column).getByRole('group', { name: 'Built-in filters' });
      for (const name of ['title_any', 'max_results']) {
        const row = within(builtin).getByRole('group', { name: `Built-in filter ${name}` });
        expect(row).toBeDisabled();
        expect(within(row).getByLabelText(`Key of built-in filter ${name}`)).toBeDisabled();
        expect(within(row).getByLabelText(`Description of built-in filter ${name}`)).toBeDisabled();
      }
      expect(within(builtin).getByText('string[]')).toBeInTheDocument(); // their type, as the router documents it
      expect(within(column).getByText(/None yet/)).toBeInTheDocument(); // and none of its own yet
    });

    it('shows the key of each custom filter with a caption, and what the script and the caller use it as', async () => {
      const user = userEvent.setup();
      const { column } = await open(user);
      await user.click(within(column).getByRole('button', { name: 'Add filter' }));
      const row = within(column).getByRole('group', { name: 'Filter 1' });
      expect(within(row).getByText('Key')).toBeVisible(); // the caption over the field, not only its accessible name
      expect(within(row).getByText('Type')).toBeVisible();
      expect(within(row).getByText('Description')).toBeVisible();
      expect(row).toHaveTextContent('The script reads it as filters.key');
      await user.type(within(row).getByLabelText('Key of filter 1'), 'contract');
      expect(within(row).getByLabelText('Key of filter 1')).toHaveValue('contract');
      expect(row).toHaveTextContent('The script reads it as filters.contract, and a caller names it contract.');
      // the built-in filters show their key the same way
      const builtin = within(column).getByRole('group', { name: 'Built-in filter title_any' });
      expect(within(builtin).getByText('Key')).toBeVisible();
      expect(within(builtin).getByLabelText('Key of built-in filter title_any')).toHaveValue('title_any');
    });

    it('adds a select filter with its options, refuses it until it is complete, and sends it with the adapter', async () => {
      const user = userEvent.setup();
      const sent: { filters: unknown[] }[] = [];
      const { dialog, column } = await open(user);
      const real = globalThis.fetch;
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          sent.push(JSON.parse(String(init.body)) as { filters: unknown[] });
          return Promise.resolve(new Response(JSON.stringify(detail()), { status: 201 }));
        }
        return real(input, init);
      });
      await user.type(within(dialog).getByLabelText('Name'), 'Acme jobs');
      await user.type(within(dialog).getByLabelText('Handle'), 'acmejobs');
      await user.clear(within(dialog).getByLabelText('URL target'));
      await user.type(within(dialog).getByLabelText('URL target'), 'https://careers.acme.com');
      const create = within(dialog).getByRole('button', { name: 'Create' });
      await waitFor(() => expect(create).toBeEnabled());

      await user.click(within(column).getByRole('button', { name: 'Add filter' }));
      expect(create).toBeDisabled(); // a new filter has no name or description yet
      await user.selectOptions(within(column).getByLabelText('Type of filter 1'), 'select');
      await user.type(within(column).getByLabelText('Key of filter 1'), 'sector');
      await user.type(within(column).getByLabelText('Description of filter 1'), 'The job sector.');
      expect(create).toBeDisabled(); // a select needs options with a value
      await user.type(within(column).getByLabelText('Value of option 1 of filter 1'), 'commercial');
      await user.type(within(column).getByLabelText('Label of option 1 of filter 1'), 'Commercial');
      await user.type(within(column).getByLabelText('Value of option 2 of filter 1'), 'it');
      await waitFor(() => expect(create).toBeEnabled());
      await user.click(within(column).getByRole('button', { name: 'Add an option to filter 1' }));
      await user.type(within(column).getByLabelText('Value of option 3 of filter 1'), 'finance');
      await user.click(within(column).getByRole('button', { name: 'Remove option 3 of filter 1' }));
      expect(within(column).queryByLabelText('Value of option 3 of filter 1')).not.toBeInTheDocument();

      await user.click(create);
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]?.filters).toEqual([
        {
          name: 'sector',
          description: 'The job sector.',
          type: 'select',
          options: [{ value: 'commercial', label: 'Commercial' }, { value: 'it' }],
        },
      ]);
    });

    it('offers every type, keeps what the kinds share when the type changes, and shows what each one needs', async () => {
      const user = userEvent.setup();
      const { column } = await open(user);
      await user.click(within(column).getByRole('button', { name: 'Add filter' }));
      const type = within(column).getByLabelText('Type of filter 1');
      expect(
        within(type)
          .getAllByRole('option')
          .map((entry) => entry.textContent),
      ).toEqual(['Select', 'Multiselect', 'Boolean', 'String', 'Number']);
      await user.type(within(column).getByLabelText('Key of filter 1'), 'remote');
      await user.type(within(column).getByLabelText('Description of filter 1'), 'Remote jobs only.');
      await user.selectOptions(type, 'multiselect');
      expect(within(column).getByLabelText('Value of option 2 of filter 1')).toBeInTheDocument();
      await user.selectOptions(type, 'boolean');
      expect(within(column).getByLabelText('Key of filter 1')).toHaveValue('remote'); // kept
      expect(within(column).getByLabelText('Description of filter 1')).toHaveValue('Remote jobs only.');
      expect(within(column).queryByLabelText('Value of option 1 of filter 1')).not.toBeInTheDocument();
      expect(within(column).getByLabelText('On when the caller leaves it out')).toBeInTheDocument();
      await user.selectOptions(type, 'string');
      expect(within(column).getByLabelText('Longest text of filter 1')).toBeInTheDocument();
      await user.selectOptions(type, 'number');
      for (const label of ['Min of filter 1', 'Max of filter 1', 'Whole numbers'])
        expect(within(column).getByLabelText(label)).toBeInTheDocument();
    });

    it('says what is wrong: a built-in name, a name used twice, a number whose max is below its min', async () => {
      const user = userEvent.setup();
      const { column } = await open(user);
      const add = within(column).getByRole('button', { name: 'Add filter' });
      await user.click(add);
      await user.type(within(column).getByLabelText('Key of filter 1'), 'max_results');
      await user.type(within(column).getByLabelText('Description of filter 1'), 'x');
      expect(await within(column).findByText('"max_results" is a built-in filter')).toBeInTheDocument();
      await user.clear(within(column).getByLabelText('Key of filter 1'));
      await user.type(within(column).getByLabelText('Key of filter 1'), 'pay');
      await user.click(add);
      await user.type(within(column).getByLabelText('Key of filter 2'), 'pay');
      await user.type(within(column).getByLabelText('Description of filter 2'), 'x');
      expect(await within(column).findByText('"pay" is used twice')).toBeInTheDocument();
      await user.selectOptions(within(column).getByLabelText('Type of filter 2'), 'number');
      await user.clear(within(column).getByLabelText('Key of filter 2'));
      await user.type(within(column).getByLabelText('Key of filter 2'), 'rate');
      await user.type(within(column).getByLabelText('Min of filter 2'), '9');
      await user.type(within(column).getByLabelText('Max of filter 2'), '1');
      expect(await within(column).findByText('Max is below min')).toBeInTheDocument();
      await user.click(within(column).getByRole('button', { name: 'Remove filter 2' }));
      expect(within(column).queryByLabelText('Key of filter 2')).not.toBeInTheDocument();
    });

    it('updates the reference as filters are typed, with the right type, and drops a filter that is not complete', async () => {
      const user = userEvent.setup();
      const { dialog, column } = await open(user);
      await user.click(within(dialog).getByRole('button', { name: 'Show the documentation' }));
      const region = await within(dialog).findByRole('region', { name: 'Script documentation' });
      const table = () => within(region).getByRole('table', { name: 'Filters' });
      expect(within(table()).getAllByRole('row')).toHaveLength(3); // the header and the two built-in filters
      await user.click(within(column).getByRole('button', { name: 'Add filter' }));
      await user.type(within(column).getByLabelText('Key of filter 1'), 'contract');
      expect(within(table()).queryByText('contract')).not.toBeInTheDocument(); // no description yet: not a filter
      await user.type(within(column).getByLabelText('Description of filter 1'), 'The contract type.');
      await user.selectOptions(within(column).getByLabelText('Type of filter 1'), 'multiselect');
      await user.type(within(column).getByLabelText('Value of option 1 of filter 1'), 'CDI');
      await user.type(within(column).getByLabelText('Value of option 2 of filter 1'), 'CDD');
      expect(await within(table()).findByText('contract')).toBeInTheDocument();
      expect(within(table()).getAllByRole('row')).toHaveLength(4);
      await user.click(within(table()).getByRole('button', { name: 'contract in Filters' }));
      expect(within(table()).getByText("('CDI' | 'CDD')[]")).toBeInTheDocument(); // the type in full
      await user.click(within(column).getByRole('button', { name: 'Add an option to filter 1' }));
      await user.type(within(column).getByLabelText('Value of option 3 of filter 1'), 'Stage');
      // while the new option has no value the filter is not complete and leaves the reference; once it has one it is back, and live
      await user.click(await within(table()).findByRole('button', { name: 'contract in Filters' }));
      expect(await within(table()).findByText("('CDI' | 'CDD' | 'Stage')[]")).toBeInTheDocument();
      await user.click(within(column).getByRole('button', { name: 'Remove filter 1' }));
      expect(within(table()).queryByText('contract')).not.toBeInTheDocument();
    });

    it('loads the filters of the adapter that is edited, and sends them back with the change', async () => {
      const user = userEvent.setup();
      const filters = [
        { name: 'contract', description: 'The contract type.', type: 'multiselect', options: [{ value: 'CDI' }, { value: 'CDD' }] },
        { name: 'remote', description: 'Remote only.', type: 'boolean', default: true },
      ];
      const sent: { filters: unknown[] }[] = [];
      mockApi(routes({ '/custom-adapters': list([adapter()]), '/custom-adapters/acmejobs': detail({ filters }) }));
      const real = globalThis.fetch;
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          sent.push(JSON.parse(String(init.body)) as { filters: unknown[] });
          return Promise.resolve(new Response(JSON.stringify(detail({ filters })), { status: 200 }));
        }
        return real(input, init);
      });
      renderApp('/custom-adapters');
      await user.click(await screen.findByRole('button', { name: 'Edit Acme jobs' }));
      const dialog = await screen.findByRole('dialog');
      const column = within(dialog).getByRole('region', { name: 'Filters' });
      expect(await within(column).findByLabelText('Key of filter 1')).toHaveValue('contract');
      expect(within(column).getByLabelText('Type of filter 1')).toHaveValue('multiselect');
      expect(within(column).getByLabelText('Value of option 2 of filter 1')).toHaveValue('CDD');
      expect(within(column).getByLabelText('Key of filter 2')).toHaveValue('remote');
      await user.click(within(column).getByRole('button', { name: 'Remove filter 2' }));
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]?.filters).toEqual([filters[0]]);
    });

    it('asks to reconnect the connector when the filters of an adapter that is on change, and only then', async () => {
      const user = userEvent.setup();
      const filters = [{ name: 'remote', description: 'Remote only.', type: 'boolean' }];
      mockApi(
        routes({ '/custom-adapters': list([adapter({ enabled: true })]), '/custom-adapters/acmejobs': detail({ enabled: true, filters }) }),
      );
      const real = globalThis.fetch;
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          const sent = JSON.parse(String(init.body)) as { filters: unknown[] };
          return Promise.resolve(new Response(JSON.stringify(detail({ enabled: true, filters: sent.filters })), { status: 200 }));
        }
        return real(input, init);
      });
      renderApp('/custom-adapters');
      await user.click(await screen.findByRole('button', { name: 'Edit Acme jobs' }));
      let dialog = await screen.findByRole('dialog');
      await within(dialog).findByLabelText('Key of filter 1');
      await user.click(within(dialog).getByRole('button', { name: 'Save' })); // nothing changed in the filters
      expect(await screen.findByRole('status')).not.toHaveTextContent('Reconnect');
      await user.click(await screen.findByRole('button', { name: 'Edit Acme jobs' }));
      dialog = await screen.findByRole('dialog');
      await user.click(await within(dialog).findByRole('button', { name: 'Remove filter 1' }));
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reconnect the Claude connector'));
    });
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

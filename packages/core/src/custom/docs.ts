/** One attribute, method or global of a documented type: what the collapsed row shows, and what its expanded description list says. */
export interface DocItem {
  name: string;
  /** Short, for the collapsed row: `function`, `string[]`, `Posting[]`. */
  type: string;
  /** In full, for the expanded row; the short one when omitted. */
  fullType?: string;
  /** What it is for and how to use it. */
  description: string;
  /** True when the script may leave it out. */
  optional?: boolean;
}

/** An object or type a script works with, as a table: the globals, an argument, what it returns. */
export interface DocBlock {
  id: string;
  title: string;
  /** One line under the title: what it is and where it comes from. */
  summary: string;
  items: DocItem[];
}

const HTTP_OPTIONS = '{ headers?: Record<string, string> }';

/**
 * The reference a script author reads next to the editor: the globals the sandbox gives, then each shape a script receives or returns,
 * one block each. It lives with the code it describes (`sandbox.ts` implements the globals, `toBoardRead` checks the output), so the
 * dashboard shows what the router really accepts. The `Session` block and the `session` global exist for the browser context only.
 */
export function scriptDocs(kind: 'http' | 'browser'): DocBlock[] {
  const globals: DocItem[] = [
    {
      name: 'http',
      type: 'Http',
      description:
        'Makes requests. They go through the router, which only lets them reach the host of the URL target, counts each one as a unit of the adapter budget (30 at most in a run) and caps their size and time. A refused host or an error status is the answer of the call, not a crash: check `ok` and `status`.',
    },
    {
      name: 'htmlToText',
      type: 'function',
      fullType: '(html: string) => Promise<string>',
      description: 'Plain text of a piece of HTML, with the list items and the line breaks kept. Await it.',
    },
    {
      name: 'slugify',
      type: 'function',
      fullType: '(text: string) => Promise<string>',
      description: 'A short lower-case name for a company: "Société Générale" becomes "societe-generale". Await it.',
    },
    {
      name: 'titleCase',
      type: 'function',
      fullType: '(text: string) => Promise<string>',
      description: 'A readable company name from a handle or a name: "société générale" becomes "Société Générale". Await it.',
    },
    {
      name: 'log',
      type: 'function',
      fullType: '(message: string) => Promise<void>',
      description: "Writes a line to the router's log (500 characters at most), to see what a script does. Await it.",
    },
  ];
  if (kind === 'browser')
    globals.push({
      name: 'session',
      type: 'Session',
      description:
        "The page of this adapter's own Chrome, on its own profile. Only one browser runs at a time across all browser adapters, so a call may wait for its turn. Its pages are limited to the host of the URL target.",
    });

  const blocks: DocBlock[] = [
    { id: 'globals', title: 'Globals', summary: 'Available in the script without declaring them.', items: globals },
    {
      id: 'http',
      title: 'Http',
      summary: 'The `http` global. Both methods answer with a Response.',
      items: [
        {
          name: 'get',
          type: 'function',
          fullType: `(url: string, options?: ${HTTP_OPTIONS}) => Promise<Response>`,
          description:
            'A GET request. The address is https and on the allowed host. `headers` may carry an API key header; cookies and credentials cannot be set.',
        },
        {
          name: 'postJson',
          type: 'function',
          fullType: `(url: string, body: unknown, options?: ${HTTP_OPTIONS}) => Promise<Response>`,
          description:
            'A POST request with `body` sent as JSON. Use it to read, for example to run a search an API only offers as a POST; the router never lets a script send anything else.',
        },
      ],
    },
    {
      id: 'response',
      title: 'Response',
      summary: 'What `http.get` and `http.postJson` give back.',
      items: [
        { name: 'status', type: 'number', description: 'The HTTP status: 200, 404...' },
        { name: 'ok', type: 'boolean', description: 'True for a status from 200 to 299.' },
        {
          name: 'headers',
          type: 'Record<string, string>',
          description: 'The response headers, with lower-case names. `set-cookie` is never there.',
        },
        { name: 'text', type: 'string', description: 'The body as text, cut at the router size cap.' },
        {
          name: 'json',
          type: 'function',
          fullType: '() => any',
          description: 'Parses the body as JSON. Throws when it is not JSON, so call it after checking `ok`.',
        },
      ],
    },
  ];
  if (kind === 'browser')
    blocks.push({
      id: 'session',
      title: 'Session',
      summary: 'The `session` global (browser context only). Every call is awaited.',
      items: [
        {
          name: 'goto',
          type: 'function',
          fullType: '(url: string, options?: { timeoutMs?: number, waitFor?: string }) => Promise<void>',
          description:
            'Loads a page in the tab (one unit of the budget). `waitFor` is a selector to wait for after the load; `timeoutMs` is 1,000 to 30,000.',
        },
        {
          name: 'waitForSelector',
          type: 'function',
          fullType: '(selector: string, timeoutMs?: number) => Promise<boolean>',
          description:
            'Waits for an element, up to `timeoutMs` (100 to 30,000, 10,000 by default). True when it appeared in time, false otherwise; it does not throw.',
        },
        {
          name: 'text',
          type: 'function',
          fullType: '(selector: string) => Promise<string | null>',
          description: 'The text of the first element that matches, or null.',
        },
        {
          name: 'evaluate',
          type: 'function',
          fullType: '(script: string, arg?: unknown) => Promise<unknown>',
          description:
            "Runs a function expression, given as text, in the page and returns its JSON result: `await session.evaluate('(ids) => ids.length', ids)`. The text is 20,000 characters at most.",
        },
        { name: 'url', type: 'function', fullType: '() => Promise<string>', description: 'The address of the page now.' },
      ],
    });
  blocks.push(
    {
      id: 'filters',
      title: 'Filters',
      summary: 'The second argument of `read`: the other arguments of the tool. The router applies them again to what you return.',
      items: [
        {
          name: 'title_any',
          type: 'string[]',
          description: 'Keywords of the title, any of which matches. Empty keeps all. Use it to ask a site for less.',
        },
        {
          name: 'location_any',
          type: 'string[]',
          description: 'Places, any of which matches (a city, a country code, a postal code). Empty keeps all.',
        },
        {
          name: 'posted_within',
          type: 'string',
          fullType: "'any' | 'last_24_hours' | 'past_week' | 'past_month'",
          description: 'How recent the jobs must be. A job with no date is kept.',
        },
        {
          name: 'disallowed_terms',
          type: 'string[]',
          description: 'Words to reject, in the title or, for some calls, in the description.',
        },
        { name: 'only_new', type: 'boolean', description: 'True when the caller only wants jobs the router has not stored before.' },
        {
          name: 'max_results',
          type: 'number',
          description: 'The most jobs the caller wants back (1 to 200). You may return more: the router cuts.',
        },
      ],
    },
    {
      id: 'posting',
      title: 'Posting',
      summary: 'One job you found. `postings` is a list of them.',
      items: [
        {
          name: 'id',
          type: 'string',
          description:
            '1 to 64 letters, digits, `-` or `_`, unique within this adapter. It is what the router stores the job under: keep it stable between calls.',
        },
        { name: 'title', type: 'string', description: 'The job title (1 to 300 characters).' },
        {
          name: 'company',
          type: 'string | null',
          optional: true,
          description: 'The company name. The router shows the name of the board when it is left out.',
        },
        {
          name: 'locations',
          type: 'string[]',
          optional: true,
          description:
            "One entry for each office, for example `['Paris, France']`. Say `Remote` here for a remote job, so a location filter can find it.",
        },
        { name: 'url', type: 'string', description: 'The public address of the job. It must be https.' },
        {
          name: 'postedAt',
          type: 'string | null',
          optional: true,
          description:
            "When it was posted: a date such as `'2026-10-01'` or a full time. Leave it out when the site does not say; a date that cannot be read counts as none.",
        },
        {
          name: 'description',
          type: 'string',
          optional: true,
          description:
            'Plain text of the job (100,000 characters at most). The router stores it, summarises it and filters on it, so give the whole text.',
        },
      ],
    },
    {
      id: 'result',
      title: 'Result',
      summary: 'What `read` returns.',
      items: [
        {
          name: 'name',
          type: 'string | null',
          optional: true,
          description: 'The company name, used to name the board in the answer. Null or left out names it after the entry of `boards`.',
        },
        { name: 'postings', type: 'Posting[]', description: 'The jobs found, 2,000 at most. A repeated `id` is kept once.' },
      ],
    },
  );
  return blocks;
}

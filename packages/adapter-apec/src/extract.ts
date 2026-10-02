/**
 * Scripts that run INSIDE an apec.fr page. Apec's own web app calls two JSON endpoints of its site; the site is behind a bot
 * protection (DataDome) that answers plain HTTP clients with a 403 challenge, but lets a real browser page call them. So the
 * adapter opens one apec.fr page and the scripts below call the endpoints from it, as the site's own pages do. Nothing is clicked
 * or typed; an answer that is not JSON is reported as blocked, and the adapter then stops (a checkpoint), never working around it.
 * Each is an async function expression that `BrowserSession.evaluate` calls with a JSON argument.
 */

/** Light page state for the session check: is a verification challenge showing? */
export const EXTRACT_PAGE_STATE = `() => ({
  challenge: !!document.querySelector('iframe[src*="captcha-delivery"], iframe[src*="geo.captcha"]') || /enable js and disable any ad blocker/i.test((document.body && document.body.innerText) || ''),
  title: document.title || '',
  hasApp: !!document.querySelector('apec-root, app-root, header, nav'),
})`;

/**
 * One call to one of the two endpoints, from the page. `arg` is `{ kind: 'search', body }` (POST to the search endpoint) or
 * `{ kind: 'offer', id }` (GET of the public offer). Retries a few times while the page's own bot check settles; returns
 * `{ status, json, blocked }` where `blocked` means "an HTML challenge came back instead of JSON".
 */
export const CALL_ENDPOINT = `async (arg) => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const attempt = async () => {
    const init =
      arg.kind === 'search'
        ? { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(arg.body) }
        : { method: 'GET', credentials: 'omit' };
    const path = arg.kind === 'search' ? '/cms/webservices/rechercheOffre' : '/cms/webservices/offre/public?numeroOffre=' + encodeURIComponent(arg.id);
    const response = await fetch(path, init);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (error) { json = null; }
    return { status: response.status, json, blocked: json === null && /captcha-delivery|enable js/i.test(text) };
  };
  let last = { status: 0, json: null, blocked: false };
  for (let tries = 0; tries < 5; tries += 1) {
    last = await attempt();
    if (last.json !== null || last.status === 404) return last;
    await sleep(1500);
  }
  return last;
}`;

export interface PageState {
  challenge: boolean;
  title: string;
  hasApp: boolean;
}

export interface EndpointAnswer {
  status: number;
  json: unknown;
  blocked: boolean;
}

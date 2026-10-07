import { AdapterBroken } from '@jobwatch/sdk';

/** One element of a parsed XML document: its name, its element children and the text directly inside it. */
export interface XmlElement {
  name: string;
  children: XmlElement[];
  text: string;
}

const MAX_DEPTH = 32;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** `&amp;`, `&#233;`, `&#xE9;` -> the character. Any other entity is left as it is: nothing is ever fetched or expanded. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,5});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

/**
 * A small XML reader for the one feed this adapter reads (elements, text, CDATA, comments; attributes are skipped). It refuses a
 * document type declaration, so no entity can be defined or expanded, and it limits the depth. A document that is not well formed
 * is `adapter_broken`: a changed answer must never turn into an empty list.
 */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '#document', children: [], text: '' };
  const stack: XmlElement[] = [root];
  const token =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE|<!ENTITY|<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)|</g;
  let at = 0;
  for (let match = token.exec(source); match !== null; match = token.exec(source)) {
    if (match.index !== at) throw new AdapterBroken('The XML answer is not well formed.');
    at = token.lastIndex;
    const whole = match[0];
    const top = stack[stack.length - 1] as XmlElement;
    if (whole.startsWith('<!DOCTYPE') || whole.startsWith('<!ENTITY')) throw new AdapterBroken('The XML answer declares a document type.');
    if (match[1] !== undefined)
      top.text += match[1]; // CDATA, kept as it is
    else if (match[3] !== undefined) {
      if (match[2] === '/') {
        if (stack.length < 2 || top.name !== match[3]) throw new AdapterBroken('The XML answer is not well formed.');
        stack.pop();
      } else {
        if (stack.length > MAX_DEPTH) throw new AdapterBroken('The XML answer is nested too deeply.');
        const element: XmlElement = { name: match[3], children: [], text: '' };
        top.children.push(element);
        if (match[5] !== '/') stack.push(element);
      }
    } else if (match[6] !== undefined) top.text += decode(match[6]);
    else if (whole === '<') throw new AdapterBroken('The XML answer is not well formed.');
  }
  if (at !== source.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim() !== '')
    throw new AdapterBroken('The XML answer is not well formed.');
  return root.children[0] as XmlElement;
}

/** The first child element called `name`, or undefined. */
export const child = (element: XmlElement, name: string): XmlElement | undefined => element.children.find((entry) => entry.name === name);

/** The trimmed text of the first child called `name`, or null when it is missing or empty. */
export const childText = (element: XmlElement, name: string): string | null => {
  const text = child(element, name)?.text.trim();
  return text === undefined || text === '' ? null : text;
};

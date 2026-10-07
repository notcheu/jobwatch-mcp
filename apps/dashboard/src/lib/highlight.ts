/** The kinds of text the editor colours. Everything else is `plain`. */
export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'global' | 'plain';
export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'const',
  'continue',
  'default',
  'do',
  'else',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'in',
  'let',
  'new',
  'null',
  'of',
  'return',
  'switch',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'while',
]);
/** What a script may call without declaring it (the SDK globals of its sandbox). */
const GLOBALS = new Set([
  'http',
  'session',
  'htmlToText',
  'slugify',
  'titleCase',
  'log',
  'JSON',
  'Math',
  'Date',
  'Array',
  'Object',
  'Promise',
  'Number',
  'String',
]);

const PATTERN =
  /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?|`(?:\\[\s\S]|[^`\\])*`?|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*/g;

/**
 * Cuts JavaScript into coloured pieces: comments, strings (an unfinished one included, so typing a quote does not colour the rest of the
 * page wrongly), numbers, keywords and the globals of the sandbox. It is not a parser: it only has to be right for what is shown while someone
 * types. The pieces joined give the text back, always.
 */
export function highlight(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  for (const match of source.matchAll(PATTERN)) {
    const text = match[0];
    const start = match.index ?? 0;
    if (start > at) tokens.push({ kind: 'plain', text: source.slice(at, start) });
    const first = text[0] ?? '';
    const kind: TokenKind =
      text.startsWith('//') || text.startsWith('/*')
        ? 'comment'
        : first === "'" || first === '"' || first === '`'
          ? 'string'
          : /\d/.test(first)
            ? 'number'
            : KEYWORDS.has(text)
              ? 'keyword'
              : GLOBALS.has(text)
                ? 'global'
                : 'plain';
    tokens.push({ kind, text });
    at = start + text.length;
  }
  if (at < source.length) tokens.push({ kind: 'plain', text: source.slice(at) });
  // neighbours of one kind are one piece
  return tokens.reduce<Token[]>((merged, token) => {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.kind === token.kind) last.text += token.text;
    else merged.push({ ...token });
    return merged;
  }, []);
}

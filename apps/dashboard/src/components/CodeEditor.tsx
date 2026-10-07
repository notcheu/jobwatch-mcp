import { useRef, type KeyboardEvent } from 'react';
import { highlight, type TokenKind } from '@/lib/highlight';
import { cn } from '@/lib/utils';

const COLOURS: Record<TokenKind, string> = {
  comment: 'text-muted-foreground italic',
  string: 'text-emerald-600 dark:text-emerald-400',
  number: 'text-amber-600 dark:text-amber-400',
  keyword: 'text-violet-600 dark:text-violet-400',
  global: 'text-sky-600 dark:text-sky-400',
  plain: '',
};

const TEXT = 'whitespace-pre p-3 font-mono text-xs leading-5';

/**
 * A small code editor: a transparent textarea over the same text drawn in colours, scrolled together. Tab indents (two spaces), Enter keeps
 * the indentation of the line, and the text is the textarea's own, so selecting, undo and pasting are the browser's. Nothing is run here.
 */
export function CodeEditor({
  value,
  onChange,
  label,
  className,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  className?: string;
  invalid?: boolean;
}) {
  const colours = useRef<HTMLPreElement>(null);

  const insert = (area: HTMLTextAreaElement, text: string): void => {
    const { selectionStart: from, selectionEnd: to } = area;
    onChange(`${value.slice(0, from)}${text}${value.slice(to)}`);
    const caret = from + text.length;
    // the caret goes after the new text once React has put it in
    requestAnimationFrame(() => area.setSelectionRange(caret, caret));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const area = event.currentTarget;
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      insert(area, '  ');
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const line = value.slice(value.lastIndexOf('\n', area.selectionStart - 1) + 1, area.selectionStart);
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
      const opens = /[{([]\s*$/.test(line);
      insert(area, `\n${indent}${opens ? '  ' : ''}`);
    }
  };

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring',
        invalid === true ? 'border-destructive' : 'border-input',
        className,
      )}
    >
      <pre ref={colours} aria-hidden="true" className={cn(TEXT, 'pointer-events-none absolute inset-0 m-0 overflow-hidden')}>
        {highlight(value).map((token, index) => (
          <span key={index} className={COLOURS[token.kind]}>
            {token.text}
          </span>
        ))}
        {'\n'}
      </pre>
      <textarea
        aria-label={label}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          if (colours.current === null) return;
          colours.current.scrollTop = event.currentTarget.scrollTop;
          colours.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        className={cn(
          TEXT,
          'relative block size-full min-h-72 resize-y overflow-auto bg-transparent text-transparent caret-foreground outline-none selection:bg-primary/25',
        )}
      />
    </div>
  );
}

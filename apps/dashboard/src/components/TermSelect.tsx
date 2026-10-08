import { Check, ChevronDown, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** The value of the "none" option: the searches that had no keyword (or no disallowed term). It excludes every other choice. */
export const NONE = '\u0000none';

/** Up to this many choices are shown as a tag each; more are summed up as "N Selected". */
const MAX_TAGS = 2;

interface Props {
  /** The name of the field, also its accessible name. */
  label: string;
  placeholder: string;
  /** Every term that can be chosen. */
  options: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** Shown as the first option, to ask for the searches that had none of these (for example "No keyword"). */
  noneLabel?: string;
  title?: string;
}

/** A multiple choice in an input: the chosen terms as tags (or "N Selected" past two), and a list of every term to pick from. */
export function TermSelect({ label, placeholder, options, selected, onChange, noneLabel, title }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return options.filter((option) => needle === '' || option.toLowerCase().includes(needle));
  }, [options, filter]);

  const labelOf = (value: string): string => (value === NONE ? (noneLabel ?? 'None') : value);
  const toggle = (value: string): void => {
    if (selected.includes(value)) onChange(selected.filter((entry) => entry !== value));
    else if (value === NONE) onChange([NONE]);
    else onChange([...selected.filter((entry) => entry !== NONE), value]);
  };
  const choices = noneLabel === undefined ? shown : [NONE, ...shown];

  return (
    <div ref={root} className="relative" onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}>
      <div
        className={cn(
          'flex h-9 min-w-52 max-w-80 items-center gap-1 rounded-md border border-input bg-background pl-2 pr-1 text-sm',
          open && 'ring-1 ring-ring',
        )}
        title={title}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {selected.length === 0 && <span className="truncate text-muted-foreground">{placeholder}</span>}
          {selected.length > MAX_TAGS ? (
            <span className="rounded bg-secondary px-1.5 py-0.5 text-xs whitespace-nowrap" title={selected.map(labelOf).join(', ')}>
              {selected.length} Selected
            </span>
          ) : (
            selected.map((value) => (
              <span key={value} className="flex min-w-0 items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5 text-xs">
                <span className="truncate">{labelOf(value)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${labelOf(value)} from ${label}`}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => toggle(value)}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))
          )}
        </div>
        {selected.length > 0 && (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
            onClick={() => onChange([])}
          >
            <X className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown className="size-4" />
        </button>
      </div>
      {open && (
        <div id={listId} className="absolute left-0 z-20 mt-1 w-72 rounded-md border bg-popover p-2 shadow-md">
          <input
            aria-label={`Find in ${label}`}
            placeholder="Find…"
            className="mb-2 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <ul role="listbox" aria-label={label} aria-multiselectable="true" className="max-h-64 space-y-0.5 overflow-auto">
            {choices.map((value) => {
              const on = selected.includes(value);
              return (
                <li key={value} role="option" aria-selected={on}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
                    onClick={() => toggle(value)}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center rounded border">
                      {on && <Check className="size-3" />}
                    </span>
                    <span className="truncate">{labelOf(value)}</span>
                  </button>
                </li>
              );
            })}
            {choices.length === 0 && <li className="px-2 py-1 text-xs text-muted-foreground">Nothing used yet.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

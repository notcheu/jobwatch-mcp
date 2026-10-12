import type { CustomFilter, CustomFilterType, DocItem } from '@jobwatch/dashboard-api';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const TYPES: { value: CustomFilterType; label: string; hint: string }[] = [
  { value: 'select', label: 'Select', hint: 'One choice among options.' },
  { value: 'multiselect', label: 'Multiselect', hint: 'Any number of choices among options.' },
  { value: 'boolean', label: 'Boolean', hint: 'On or off.' },
  { value: 'string', label: 'String', hint: 'Free text.' },
  { value: 'number', label: 'Number', hint: 'A number, optionally whole and within a range.' },
];

const field = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60';

/** A new filter of a type, keeping what the kinds share (name, label, description) when the type of an existing one changes. */
export function filterOfType(type: CustomFilterType, from?: Partial<CustomFilter>): CustomFilter {
  const common = { name: from?.name ?? '', description: from?.description ?? '', ...(from?.label ? { label: from.label } : {}) };
  switch (type) {
    case 'select':
    case 'multiselect':
      return { ...common, type, options: [{ value: '' }, { value: '' }] };
    case 'boolean':
      return { ...common, type };
    case 'string':
      return { ...common, type };
    case 'number':
      return { ...common, type };
  }
}

const numberOf = (text: string): number | undefined => (text.trim() === '' || Number.isNaN(Number(text)) ? undefined : Number(text));

function omit<T extends object>(value: T, key: keyof T): T {
  const { [key]: _removed, ...rest } = value;
  return rest as T;
}

function CustomFilterRow({
  index,
  filter,
  problems,
  onChange,
  onRemove,
}: {
  index: number;
  filter: CustomFilter;
  problems: readonly string[];
  onChange: (next: CustomFilter) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const set = (patch: Record<string, unknown>): void => onChange({ ...filter, ...patch } as CustomFilter);
  const unset = (key: string): void => onChange(omit(filter, key as never));
  return (
    <fieldset className="space-y-2 rounded-md border p-3" aria-label={`Filter ${n}`}>
      <div className="flex items-center gap-2">
        <Input
          aria-label={`Name of filter ${n}`}
          value={filter.name}
          maxLength={32}
          placeholder="contract"
          className="font-mono"
          onChange={(event) => set({ name: event.target.value.toLowerCase() })}
        />
        <select
          aria-label={`Type of filter ${n}`}
          className={`${field} w-36 shrink-0`}
          value={filter.type}
          title={TYPES.find((entry) => entry.value === filter.type)?.hint}
          onChange={(event) => onChange(filterOfType(event.target.value as CustomFilterType, filter))}
        >
          {TYPES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Remove filter ${n}`} onClick={onRemove}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Input
        aria-label={`Label of filter ${n}`}
        value={filter.label ?? ''}
        maxLength={80}
        placeholder="Label (optional): Contract type"
        onChange={(event) => (event.target.value === '' ? unset('label') : set({ label: event.target.value }))}
      />
      <Input
        aria-label={`Description of filter ${n}`}
        value={filter.description}
        maxLength={200}
        placeholder="What it asks the site for"
        onChange={(event) => set({ description: event.target.value })}
      />

      {(filter.type === 'select' || filter.type === 'multiselect') && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">Options: the value is what the script receives</div>
          {filter.options.map((option, at) => (
            <div key={at} className="flex items-center gap-1.5">
              <Input
                aria-label={`Value of option ${at + 1} of filter ${n}`}
                value={option.value}
                maxLength={60}
                placeholder="Value"
                className="font-mono"
                onChange={(event) =>
                  set({ options: filter.options.map((entry, i) => (i === at ? { ...entry, value: event.target.value } : entry)) })
                }
              />
              <Input
                aria-label={`Label of option ${at + 1} of filter ${n}`}
                value={option.label ?? ''}
                maxLength={80}
                placeholder="Label (optional)"
                onChange={(event) =>
                  set({
                    options: filter.options.map((entry, i) =>
                      i === at ? (event.target.value === '' ? omit(entry, 'label') : { ...entry, label: event.target.value }) : entry,
                    ),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label={`Remove option ${at + 1} of filter ${n}`}
                disabled={filter.options.length <= 2}
                onClick={() => set({ options: filter.options.filter((_, i) => i !== at) })}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Add an option to filter ${n}`}
            disabled={filter.options.length >= 100}
            onClick={() => set({ options: [...filter.options, { value: '' }] })}
          >
            <Plus className="size-3.5" /> Add option
          </Button>
        </div>
      )}
      {filter.type === 'boolean' && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filter.default === true}
            onChange={(event) => (event.target.checked ? set({ default: true }) : unset('default'))}
          />
          On when the caller leaves it out
        </label>
      )}
      {filter.type === 'string' && (
        <label className="flex items-center gap-2 text-sm">
          Longest text
          <Input
            type="number"
            aria-label={`Longest text of filter ${n}`}
            className="w-24"
            min={1}
            max={200}
            value={filter.maxLength ?? ''}
            placeholder="100"
            onChange={(event) => {
              const value = numberOf(event.target.value);
              if (value === undefined) unset('maxLength');
              else set({ maxLength: value });
            }}
          />
        </label>
      )}
      {filter.type === 'number' && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={filter.integer === true}
              onChange={(event) => (event.target.checked ? set({ integer: true }) : unset('integer'))}
            />
            Whole numbers
          </label>
          {(['min', 'max'] as const).map((bound) => (
            <label key={bound} className="flex items-center gap-2">
              {bound === 'min' ? 'Min' : 'Max'}
              <Input
                type="number"
                aria-label={`${bound === 'min' ? 'Min' : 'Max'} of filter ${n}`}
                className="w-24"
                value={filter[bound] ?? ''}
                onChange={(event) => {
                  const value = numberOf(event.target.value);
                  if (value === undefined) unset(bound);
                  else set({ [bound]: value });
                }}
              />
            </label>
          ))}
        </div>
      )}
      {problems.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive" aria-label={`Problems with filter ${n}`}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/**
 * The filters of a custom adapter, in a column: the built-in ones first, shown and locked (the router applies them for every
 * company-board tool), then the adapter's own, which can be added, edited and removed. Their rows come from the router's reference, so
 * they are the filters the tool really has.
 */
export function CustomFilters({
  builtin,
  filters,
  problems,
  onChange,
}: {
  builtin: readonly DocItem[];
  filters: readonly CustomFilter[];
  problems: ReadonlyMap<number, string[]>;
  onChange: (next: CustomFilter[]) => void;
}) {
  const tooMany = problems.get(12) ?? [];
  return (
    <section aria-label="Filters" className="flex min-h-80 min-w-0 flex-col gap-2 md:min-h-0">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Filters</div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={filters.length >= 12}
          onClick={() => onChange([...filters, filterOfType('string')])}
        >
          <Plus className="size-4" /> Add filter
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Arguments of the tool beyond the built-in ones. The router does not apply yours: the script receives them in <code>filters</code>{' '}
        and sends them to the site.
      </p>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto md:pr-1">
        <div className="space-y-2" role="group" aria-label="Custom filters">
          {filters.length === 0 && <p className="text-xs text-muted-foreground">None yet. Add one to map a filter of the site.</p>}
          {filters.map((filter, index) => (
            <CustomFilterRow
              key={index}
              index={index}
              filter={filter}
              problems={problems.get(index) ?? []}
              onChange={(next) => onChange(filters.map((entry, i) => (i === index ? next : entry)))}
              onRemove={() => onChange(filters.filter((_, i) => i !== index))}
            />
          ))}
          {tooMany.length > 0 && <p className="text-xs text-destructive">{tooMany.join(' ')}</p>}
        </div>
        <div className="space-y-2" role="group" aria-label="Built-in filters">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Lock className="size-3" /> Built-in (always there)
          </div>
          {builtin.length === 0 && <p className="text-xs text-muted-foreground">Loading…</p>}
          {builtin.map((item) => (
            <fieldset
              key={item.name}
              disabled
              className="space-y-1.5 rounded-md border bg-muted/30 p-2"
              aria-label={`Built-in filter ${item.name}`}
            >
              <div className="flex items-center gap-2">
                <Input aria-label={`Name of built-in filter ${item.name}`} value={item.name} readOnly className="font-mono" />
                <Badge variant="secondary" className="shrink-0" title={item.fullType ?? item.type}>
                  {item.type}
                </Badge>
              </div>
              <Input aria-label={`Description of built-in filter ${item.name}`} value={item.description} readOnly />
            </fieldset>
          ))}
        </div>
      </div>
    </section>
  );
}

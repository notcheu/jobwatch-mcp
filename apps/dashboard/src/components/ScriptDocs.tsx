import type { DocBlock, DocItem } from '@jobwatch/dashboard-api';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '@/lib/utils';

/** A table cell of text with `backticks` shown as code, so the descriptions read like the documentation they come from. */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, index) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.7rem]">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

/**
 * One attribute: a row that shows its name, its short type and whether it is required, and opens into a description list (name,
 * description, type in full), the way the API reference of Base UI does. The row is a button, so the keyboard opens it.
 */
function DocRow({ item, block }: { item: DocItem; block: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <tr className="border-t first:border-t-0">
        <th scope="row" className="w-1/3 p-0 text-left font-normal">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panel}
            aria-label={`${item.name} in ${block}`}
            onClick={() => setOpen((value) => !value)}
            className="flex w-full items-center gap-1 px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          >
            <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <code className="font-mono text-xs font-medium">{item.name}</code>
          </button>
        </th>
        <td className="px-2 py-1.5">
          <code className="font-mono text-xs text-muted-foreground">{item.type}</code>
        </td>
        <td className="w-20 px-2 py-1.5 text-xs text-muted-foreground">{item.optional === true ? 'Optional' : 'Required'}</td>
      </tr>
      <tr id={panel} hidden={!open} className="bg-muted/40">
        <td colSpan={3} className="p-0">
          {open && (
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-2 text-xs">
              <dt className="font-medium text-muted-foreground">Name</dt>
              <dd>
                <code className="font-mono">{item.name}</code>
              </dd>
              <dt className="font-medium text-muted-foreground">Description</dt>
              <dd className="leading-relaxed">
                <Prose text={item.description} />
              </dd>
              <dt className="font-medium text-muted-foreground">Type</dt>
              <dd>
                <code className="font-mono break-words whitespace-pre-wrap">{item.fullType ?? item.type}</code>
              </dd>
              <dt className="font-medium text-muted-foreground">Required</dt>
              <dd>{item.optional === true ? 'No: leave it out when you have nothing for it.' : 'Yes.'}</dd>
            </dl>
          )}
        </td>
      </tr>
    </>
  );
}

/** An object or type, with the table of what it holds. */
function DocTable({ block }: { block: DocBlock }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="space-y-1.5">
      <div>
        <h4 id={heading} className="font-mono text-sm font-semibold">
          {block.title}
        </h4>
        <p className="text-xs text-muted-foreground">
          <Prose text={block.summary} />
        </p>
      </div>
      <div className="overflow-hidden rounded-md border bg-card">
        <table aria-label={block.title} className="w-full table-fixed text-left">
          <thead className="bg-muted/60 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="w-1/3 px-2 py-1 font-medium">
                Name
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                Type
              </th>
              <th scope="col" className="w-20 px-2 py-1 font-medium">
                Required
              </th>
            </tr>
          </thead>
          <tbody>
            {block.items.map((item) => (
              <DocRow key={item.name} item={item} block={block.title} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The reference beside the script editor: one table for each object or type a script uses. */
export function ScriptDocs({ blocks, className, id }: { blocks: readonly DocBlock[]; className?: string; id?: string }) {
  return (
    <div
      id={id}
      role="region"
      aria-label="Script documentation"
      className={cn('space-y-4 overflow-auto rounded-md border bg-background p-3', className)}
    >
      {blocks.map((block) => (
        <DocTable key={block.id} block={block} />
      ))}
    </div>
  );
}

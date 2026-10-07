import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * The keywords of a search, one badge each (any of them matches). Wraps inside its container and shortens a long keyword with an
 * ellipsis (its whole text is the tooltip), so a cell never grows past its column.
 */
export function KeywordBadges({
  keywords,
  empty = '(no keywords)',
  variant = 'default',
  className,
}: {
  keywords: readonly string[];
  empty?: string;
  variant?: 'default' | 'warning';
  className?: string;
}) {
  if (keywords.length === 0) return empty === '' ? null : <span className="text-muted-foreground">{empty}</span>;
  return (
    <span className={cn('flex min-w-0 max-w-full flex-wrap gap-1', className)}>
      {keywords.map((keyword) => (
        <Badge key={keyword} variant={variant} title={keyword} className="max-w-full min-w-0 overflow-hidden text-ellipsis">
          {keyword}
        </Badge>
      ))}
    </span>
  );
}

/** The disallowed terms of a search: the same badges in another colour, so they are never taken for keywords. */
export function DisallowedBadges({ terms, empty = '–', className }: { terms: readonly string[]; empty?: string; className?: string }) {
  return <KeywordBadges keywords={terms} empty={empty} variant="warning" {...(className === undefined ? {} : { className })} />;
}

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * The keywords of a search, one badge each (any of them matches). Wraps inside its container and shortens a long keyword with an
 * ellipsis (its whole text is the tooltip), so a cell never grows past its column.
 */
export function KeywordBadges({
  keywords,
  empty = '(no keywords)',
  className,
}: {
  keywords: readonly string[];
  empty?: string;
  className?: string;
}) {
  if (keywords.length === 0) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <span className={cn('flex min-w-0 max-w-full flex-wrap gap-1', className)}>
      {keywords.map((keyword) => (
        <Badge key={keyword} title={keyword} className="max-w-full min-w-0 overflow-hidden text-ellipsis">
          {keyword}
        </Badge>
      ))}
    </span>
  );
}

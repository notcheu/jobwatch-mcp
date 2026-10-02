import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function StatCard({
  title,
  value,
  note,
  tone,
  children,
}: {
  title: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'success' | 'warning' | 'destructive';
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            'text-3xl font-semibold tabular-nums',
            tone === 'success' && 'text-success',
            tone === 'warning' && 'text-warning',
            tone === 'destructive' && 'text-destructive',
          )}
        >
          {value}
        </div>
        {note !== undefined && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
        {children}
      </CardContent>
    </Card>
  );
}

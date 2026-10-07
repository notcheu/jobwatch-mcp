import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** The panel on the right of a table: opens on a row, closes with Escape or the button. */
export function DetailPanel({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  /** A line under the title (a job's company and place). */
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside aria-label={title} className="flex w-[26rem] shrink-0 flex-col border-l bg-card">
      <div className="flex items-start justify-between gap-2 border-b px-4 py-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold break-words">{title}</h2>
          {subtitle !== undefined && <p className="text-sm break-words text-muted-foreground">{subtitle}</p>}
        </div>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close the detail" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex-1 space-y-4 overflow-auto p-4">{children}</div>
    </aside>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm break-words">{children}</div>
    </div>
  );
}

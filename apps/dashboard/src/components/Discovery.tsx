import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api, navigation } from '@/lib/api';

/** Rows per page of the tables of the utility pages. */
export const PAGE_SIZE = 25;

/** Say what went wrong, or ask for a new sign-in when the change needs a recent one. */
export function useChangeError(onReauth: () => void) {
  const [error, setError] = useState<string>();
  return {
    error,
    clear: () => setError(undefined),
    fail: (failure: unknown, fallback: string): void => {
      if (failure instanceof ApiError && failure.code === 'reauth_required') return onReauth();
      setError(failure instanceof Error ? failure.message : fallback);
    },
  };
}

export function Pager({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  return (
    <div className="flex items-center justify-between border-t px-5 py-2 text-sm">
      <span className="text-muted-foreground tabular-nums">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="size-4" /> Previous
        </Button>
        <Button variant="outline" size="sm" disabled={page * PAGE_SIZE >= total} onClick={() => onPage(page + 1)}>
          Next <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** The banners above a utility page: a change that needs a new sign-in, the last change made, and a utility that is switched off. */
export function DiscoveryBanners({
  utility,
  reauth,
  notice,
}: {
  /** The id of the utility the page is about (`ats-discovery`): the page says when it is not enabled. */
  utility: string;
  reauth: boolean;
  notice: string | undefined;
}) {
  const tools = useQuery({ queryKey: ['tools'], queryFn: api.tools });
  const module = tools.data?.adapters.find((entry) => entry.id === utility);
  return (
    <>
      {module !== undefined && !module.enabled && (
        <p role="note" className="border-b border-warning/40 bg-warning/10 px-5 py-2 text-sm">
          The <code>{utility}</code> utility is not enabled, so nothing new is logged. Enable it in Settings, Tools & status.
        </p>
      )}
      {reauth && (
        <div role="alert" className="flex items-center justify-between border-b border-warning/40 bg-warning/10 px-5 py-2 text-sm">
          <span>Changes need a recent sign-in. Sign in again to continue.</span>
          <Button size="sm" onClick={() => navigation.toReauth()}>
            Sign in again
          </Button>
        </div>
      )}
      {notice !== undefined && (
        <p role="status" className="border-b bg-success/10 px-5 py-2 text-sm">
          {notice}
        </p>
      )}
    </>
  );
}

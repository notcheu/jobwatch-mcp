import { Hand } from 'lucide-react';

/** The icon of a custom adapter: a hand, because someone made it by hand on this dashboard. One constant, so the choice is one line. */
const CustomIcon = Hand;

/**
 * A small round icon floating on the top right corner of a tab, like a notification, to say its adapter is a custom one. The tab must be
 * `relative`. The name of a custom adapter carries no mark of its own, so the tab is where it shows.
 */
export function CustomMark() {
  return (
    <span
      role="img"
      aria-label="Custom adapter"
      title="Custom adapter: written on this dashboard"
      className="pointer-events-none absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background"
    >
      <CustomIcon className="size-2.5" aria-hidden />
    </span>
  );
}

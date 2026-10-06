import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Shown greyed out and skipped by the arrow keys; `hint` says why. */
  disabled?: boolean;
  hint?: string;
  destructive?: boolean;
}

/**
 * An icon button that opens a menu of actions, written here (no dependency) with what a menu owes the keyboard and a screen reader:
 * the button announces it opens a menu, the arrow keys, Home and End move between the actions, Enter and Space pick one, Escape or
 * a click outside closes it and Escape gives the focus back to the button.
 */
export function ActionsMenu({
  label,
  icon,
  actions,
  className,
}: {
  label: string;
  icon: ReactNode;
  actions: MenuAction[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const enabled = (): HTMLButtonElement[] => [
    ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []),
  ];

  useEffect(() => {
    if (!open) return;
    enabled()[0]?.focus();
    const away = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = (focusTrigger: boolean): void => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!open) return;
    const items = enabled();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (index: number): void => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at <= 0 ? items.length - 1 : at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(items.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') close(false);
  };

  return (
    <div ref={root} className={cn('relative', className)} onKeyDown={onKeyDown}>
      <Button
        ref={trigger}
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {icon}
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full z-30 mt-1 min-w-48 rounded-md border bg-card p-1 text-card-foreground shadow-lg"
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={action.disabled ? true : undefined}
              title={action.hint}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm focus-visible:outline-none',
                action.disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent focus-visible:bg-accent',
                action.destructive && !action.disabled && 'text-destructive',
              )}
              onClick={() => {
                if (action.disabled) return;
                close(false);
                action.onSelect();
              }}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

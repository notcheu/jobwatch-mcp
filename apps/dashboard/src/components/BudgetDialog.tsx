import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Budget, BudgetValue } from '@jobwatch/dashboard-api';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api';

/** The range the router accepts: whole numbers, 0 included (0 refuses every call). */
export const BUDGET_MIN = 0;
export const BUDGET_MAX = 1_000_000;

const WINDOWS = [
  { key: 'hourly', label: 'Hourly budget', unit: 'per hour' },
  { key: 'daily', label: 'Daily budget', unit: 'per day' },
] as const;

const parse = (text: string): number | undefined => {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const value = Number(text);
  return value >= BUDGET_MIN && value <= BUDGET_MAX ? value : undefined;
};

/** Content of the dialog, mounted only while it is open, so every opening starts from what the router says now. */
function BudgetForm({
  id,
  name,
  budget,
  onClose,
  onSaved,
  onReauth,
}: {
  id: string;
  name: string;
  budget: Budget;
  onClose: () => void;
  onSaved: (message: string) => void;
  onReauth: () => void;
}) {
  const client = useQueryClient();
  const [text, setText] = useState({ hourly: String(budget.hourly.value), daily: String(budget.daily.value) });
  const [error, setError] = useState<string>();
  const locked = WINDOWS.filter(({ key }) => budget[key].source === 'env');
  const free = WINDOWS.filter(({ key }) => budget[key].source !== 'env');

  const save = useMutation({
    mutationFn: () => {
      // only the windows the environment does not set: the others cannot change, whatever the page says
      const body: { hourly?: number; daily?: number } = {};
      for (const { key } of free) body[key] = parse(text[key]) as number;
      return api.setBudget(id, body);
    },
    onSuccess: ({ budget: saved }) => {
      void client.invalidateQueries({ queryKey: ['tools'] });
      onSaved(`Budget of ${name} saved: ${saved.hourly.value} per hour, ${saved.daily.value} per day.`);
      onClose();
    },
    onError: (failure) => {
      if (failure instanceof ApiError && failure.code === 'reauth_required') {
        onClose();
        return onReauth();
      }
      setError(failure instanceof Error ? failure.message : 'The change failed.');
    },
  });

  const invalid = free.some(({ key }) => parse(text[key]) === undefined);
  const unchanged = free.every(({ key }) => parse(text[key]) === budget[key].value);
  const hourly = parse(text.hourly) ?? budget.hourly.value;
  const daily = parse(text.daily) ?? budget.daily.value;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Budget of {name}</DialogTitle>
        <DialogDescription>
          How many requests {name} may make in any one hour and in any 24 hours. A call that would go over is refused until there is room
          again.
        </DialogDescription>
      </DialogHeader>

      {locked.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <p>
              {locked.length === WINDOWS.length ? 'The environment sets both budgets' : 'The environment sets one budget'}, and it overrides
              the saved configuration. {locked.length === WINDOWS.length ? 'They' : 'It'} cannot be changed here.
            </p>
            <ul className="list-disc pl-4">
              {locked.map(({ key, unit }) => (
                <li key={key}>
                  <code>{budget[key].envVar}</code> = {budget[key].value} {unit}
                </li>
              ))}
            </ul>
            <p>Unset {locked.length === 1 ? 'the variable' : 'the variables'} to edit here.</p>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {WINDOWS.map(({ key, label }) => {
          const value: BudgetValue = budget[key];
          const isLocked = value.source === 'env';
          const bad = !isLocked && parse(text[key]) === undefined;
          return (
            <div key={key} className="space-y-1">
              <label htmlFor={`${id}-${key}`} className="text-sm font-medium">
                {label}
              </label>
              <Input
                id={`${id}-${key}`}
                type="number"
                inputMode="numeric"
                min={BUDGET_MIN}
                max={BUDGET_MAX}
                step={1}
                value={isLocked ? String(value.value) : text[key]}
                disabled={isLocked}
                aria-invalid={bad || undefined}
                aria-describedby={`${id}-${key}-hint`}
                onChange={(event) => setText((current) => ({ ...current, [key]: event.target.value }))}
              />
              <p id={`${id}-${key}-hint`} className={bad ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {bad
                  ? `A whole number from ${BUDGET_MIN} to ${BUDGET_MAX.toLocaleString('en-US')}.`
                  : isLocked
                    ? `Set by ${value.envVar}.`
                    : `Default ${value.default.toLocaleString('en-US')}${value.source === 'config' ? ', saved ' + value.value.toLocaleString('en-US') : ''}.`}
              </p>
            </div>
          );
        })}
      </div>

      {!invalid && hourly > daily && (
        <p className="text-xs text-muted-foreground">The hourly budget is above the daily one: the daily limit always applies first.</p>
      )}
      {error !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <DialogFooter className="items-center sm:justify-between">
        <Button
          variant="ghost"
          size="sm"
          disabled={free.length === 0 || save.isPending}
          onClick={() =>
            setText((current) => ({
              hourly: free.some(({ key }) => key === 'hourly') ? String(budget.hourly.default) : current.hourly,
              daily: free.some(({ key }) => key === 'daily') ? String(budget.daily.default) : current.daily,
            }))
          }
        >
          Use the defaults
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={free.length === 0 || invalid || unchanged || save.isPending}>
            Save
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

export function BudgetDialog(props: {
  open: boolean;
  id: string;
  name: string;
  budget: Budget;
  onClose: () => void;
  onSaved: (message: string) => void;
  onReauth: () => void;
}) {
  const { open, onClose, ...form } = props;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">{open && <BudgetForm {...form} onClose={onClose} />}</DialogContent>
    </Dialog>
  );
}

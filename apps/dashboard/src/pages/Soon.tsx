export function Soon({ name }: { name: string }) {
  return (
    <div className="flex w-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
      <p>
        <strong className="text-foreground">{name}</strong> is not built yet. It is planned in <code>docs/plans/17-dashboard.md</code>.
      </p>
    </div>
  );
}

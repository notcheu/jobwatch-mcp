import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** A JSON value as formatted text with a copy button. The text is plain: nothing in it is ever interpreted as HTML. */
export function JsonView({ value, label }: { value: unknown; label: string }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="relative rounded-md border bg-muted/40">
      <Button
        variant="ghost"
        size="sm"
        className="absolute right-1 top-1 h-7"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <pre aria-label={label} className="max-h-96 overflow-auto p-3 pr-20 text-xs leading-relaxed whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  );
}

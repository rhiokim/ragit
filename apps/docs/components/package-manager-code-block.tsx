'use client';

import { Check, Clipboard, Terminal } from 'lucide-react';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { useCopyButton } from 'fumadocs-ui/utils/use-copy-button';

import { usePackageManager } from '@/components/provider';
import { cn } from '@/lib/cn';
import {
  PACKAGE_MANAGERS,
  type PackageManagerTabs,
} from '@/lib/package-manager-tabs';

type PackageManagerCodeBlockProps = {
  tabs: PackageManagerTabs;
};

export function PackageManagerCodeBlock({
  tabs,
}: PackageManagerCodeBlockProps) {
  const { packageManager, setPackageManager } = usePackageManager();
  const [checked, onCopy] = useCopyButton(() =>
    navigator.clipboard.writeText(tabs[packageManager])
  );

  return (
    <div className="my-4 overflow-hidden rounded-xl border bg-fd-card text-sm shadow-sm">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="flex size-5 shrink-0 items-center justify-center rounded-md bg-fd-secondary text-fd-muted-foreground">
          <Terminal className="size-3.5" />
        </div>
        <div
          role="tablist"
          aria-label="Package managers"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {PACKAGE_MANAGERS.map((value) => {
            const active = value === packageManager;

            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={active}
                className={cn(
                  buttonVariants({
                    variant: 'ghost',
                    size: 'sm',
                  }),
                  'h-8 rounded-md px-2.5 text-xs',
                  active
                    ? 'bg-fd-accent text-fd-accent-foreground shadow-sm'
                    : 'text-fd-muted-foreground'
                )}
                onClick={() => setPackageManager(value)}
              >
                {value}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-label={checked ? 'Copied Text' : 'Copy Text'}
          className={cn(
            buttonVariants({
              variant: 'ghost',
              size: 'icon-xs',
            }),
            'shrink-0 text-fd-muted-foreground hover:text-fd-accent-foreground'
          )}
          onClick={onCopy}
        >
          {checked ? <Check /> : <Clipboard />}
        </button>
      </div>
      <div
        dir="ltr"
        className="max-h-[600px] overflow-auto px-4 py-3.5 text-[0.8125rem]"
      >
        <pre className="min-w-full w-max font-mono leading-6" data-language="bash">
          {tabs[packageManager]}
        </pre>
      </div>
    </div>
  );
}

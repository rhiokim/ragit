'use client';

import { cn } from '@/lib/cn';
import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useEffect, useState } from 'react';
import type { SidebarPageTreeComponents } from 'fumadocs-ui/components/sidebar/page-tree';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type FolderProps = ComponentProps<SidebarPageTreeComponents['Folder']>;
type ItemProps = ComponentProps<SidebarPageTreeComponents['Item']>;

type SidebarTreeNode = {
  type: 'item' | 'folder' | 'separator';
  url?: string;
  index?: {
    url: string;
  } | null;
  children?: SidebarTreeNode[];
};

function normalizePathname(pathname: string) {
  if (pathname !== '/' && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

function matchesPath(pathname: string, node: SidebarTreeNode): boolean {
  if (node.type === 'item') {
    return normalizePathname(node.url ?? '') === pathname;
  }

  if (node.type === 'folder') {
    if (normalizePathname(node.index?.url ?? '') === pathname) {
      return true;
    }

    return node.children?.some((child) => matchesPath(pathname, child)) ?? false;
  }

  return false;
}

export function Folder({ children, item }: FolderProps) {
  const pathname = normalizePathname(usePathname());
  const hasActiveItem = matchesPath(pathname, item as SidebarTreeNode);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (hasActiveItem) {
      setOpen(true);
    }
  }, [hasActiveItem]);

  const headerClassName = cn(
    'flex min-w-0 flex-1 items-center rounded-lg px-2 py-2 text-sm font-medium transition-colors',
    hasActiveItem
      ? 'text-fd-foreground'
      : 'text-fd-muted-foreground hover:bg-fd-accent/50 hover:text-fd-foreground'
  );

  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-1">
        {item.index ? (
          <Link href={item.index.url} className={headerClassName}>
            <span className="truncate">{item.name}</span>
          </Link>
        ) : (
          <button
            type="button"
            className={cn(headerClassName, 'text-left')}
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
          >
            <span className="truncate">{item.name}</span>
          </button>
        )}
        <button
          type="button"
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fd-muted-foreground transition-colors hover:bg-fd-accent/50 hover:text-fd-foreground',
            open && 'text-fd-foreground'
          )}
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? `${item.name} 접기` : `${item.name} 펼치기`}
          aria-expanded={open}
        >
          <ChevronDown
            className={cn('size-4 transition-transform duration-200', open && 'rotate-180')}
          />
        </button>
      </div>
      {open ? <div className="ml-3 border-l border-fd-border/60 pl-3">{children}</div> : null}
    </div>
  );
}

export function Item({ item }: ItemProps) {
  const pathname = normalizePathname(usePathname());
  const isActive = normalizePathname(item.url) === pathname;

  return (
    <Link
      href={item.url}
      className={cn(
        'flex items-center rounded-lg px-3 py-2 text-sm transition-colors',
        isActive
          ? 'bg-fd-accent text-fd-accent-foreground'
          : 'text-fd-muted-foreground hover:bg-fd-accent/50 hover:text-fd-foreground'
      )}
    >
      <span className="truncate">{item.name}</span>
    </Link>
  );
}

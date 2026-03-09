'use client';

import { projectLinks } from '@/lib/layout.shared';
import { Folder, Item } from '@/components/sidebar-page-tree';
import { PanelLeft } from 'lucide-react';
import { LargeSearchToggle } from '../node_modules/fumadocs-ui/dist/layouts/shared/search-toggle.js';
import { ThemeToggle } from '../node_modules/fumadocs-ui/dist/layouts/shared/theme-toggle.js';
import {
  SidebarCollapseTrigger,
  SidebarContent,
  SidebarDrawer,
  SidebarPageTree,
  SidebarTrigger,
  SidebarViewport,
} from '../node_modules/fumadocs-ui/dist/layouts/docs/sidebar.js';

const iconButtonClassName =
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors duration-100 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring hover:bg-fd-accent hover:text-fd-accent-foreground p-1.5 [&_svg]:size-4.5';

const sidebarTriggerClassName = `${iconButtonClassName} mb-auto text-fd-muted-foreground`;
const mobileTriggerClassName = `${iconButtonClassName} p-2`;
const metadataLinkClassName =
  'text-xs text-fd-muted-foreground transition-colors hover:text-fd-foreground underline-offset-4 hover:underline';

function GitHubIcon() {
  return (
    <svg role="img" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function GitHubLink({ className }: { className: string }) {
  return (
    <a
      href={projectLinks.github}
      rel="noreferrer noopener"
      target="_blank"
      aria-label="GitHub"
      className={className}
    >
      <GitHubIcon />
    </a>
  );
}

export function DocsSidebar() {
  return (
    <>
      <SidebarContent>
        <div className="flex flex-col gap-3 p-4 pb-2">
          <div className="flex">
            <div className="me-auto" />
            <SidebarCollapseTrigger className={sidebarTriggerClassName}>
              <PanelLeft />
            </SidebarCollapseTrigger>
          </div>
          <LargeSearchToggle hideIfDisabled />
        </div>
        <SidebarViewport>
          <SidebarPageTree Folder={Folder} Item={Item} />
        </SidebarViewport>
        <div className="flex flex-col border-t p-4 pt-2 empty:hidden">
          <div className="flex text-fd-muted-foreground items-center empty:hidden">
            <GitHubLink className={iconButtonClassName} />
            <ThemeToggle className="ms-auto p-0" />
          </div>
          <a
            href={projectLinks.license}
            rel="noreferrer noopener"
            target="_blank"
            className={`${metadataLinkClassName} mt-3`}
          >
            Licensed under Apache-2.0
          </a>
        </div>
      </SidebarContent>
      <SidebarDrawer>
        <div className="flex flex-col gap-3 p-4 pb-2">
          <div className="flex text-fd-muted-foreground items-center gap-1.5">
            <div className="flex flex-1">
              <GitHubLink className={mobileTriggerClassName} />
            </div>
            <ThemeToggle className="p-0" />
            <SidebarTrigger className={mobileTriggerClassName}>
              <PanelLeft />
            </SidebarTrigger>
          </div>
          <a
            href={projectLinks.license}
            rel="noreferrer noopener"
            target="_blank"
            className={metadataLinkClassName}
          >
            Licensed under Apache-2.0
          </a>
        </div>
        <SidebarViewport>
          <SidebarPageTree Folder={Folder} Item={Item} />
        </SidebarViewport>
        <div className="flex flex-col border-t p-4 pt-2 empty:hidden" />
      </SidebarDrawer>
    </>
  );
}

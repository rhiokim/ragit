import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import rehypePrettyCode from 'rehype-pretty-code';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';

import { buildPackageManagerTabs } from './lib/package-manager-tabs';

// You can customise Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
const docsOptions = {
  schema: pageSchema,
  postprocess: {
    includeProcessedMarkdown: true,
  },
};

const metaOptions = {
  schema: metaSchema,
};

export const docsEn = defineDocs({
  dir: 'content/docs/en',
  docs: {
    ...docsOptions,
  },
  meta: {
    ...metaOptions,
  },
});

export const docsKo = defineDocs({
  dir: 'content/docs/ko',
  docs: {
    ...docsOptions,
  },
  meta: {
    ...metaOptions,
  },
});

export default defineConfig({
  mdxOptions: {
    rehypePlugins: (plugins) => {
      plugins.shift();
      plugins.push([
        rehypePrettyCode as any,
        {
          theme: {
            dark: 'github-dark',
            light: 'github-light',
          },
          transformers: [
            {
              code(this: { source?: string }, node: { tagName?: string; properties: Record<string, unknown> }) {
                if (node.tagName !== 'code' || typeof this.source !== 'string') {
                  return;
                }

                const packageManagerTabs = buildPackageManagerTabs(this.source);
                if (!packageManagerTabs) {
                  return;
                }

                node.properties.__raw__ = this.source;
                node.properties.__npm__ = packageManagerTabs.tabs.npm;
                node.properties.__yarn__ = packageManagerTabs.tabs.yarn;
                node.properties.__pnpm__ = packageManagerTabs.tabs.pnpm;
                node.properties.__bun__ = packageManagerTabs.tabs.bun;
              },
            },
          ],
        },
      ]);

      return plugins;
    },
  },
});

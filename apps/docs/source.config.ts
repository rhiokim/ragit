import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';

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
    // MDX options
  },
});

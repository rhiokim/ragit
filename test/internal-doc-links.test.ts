import { describe, expect, it } from 'vitest'

import {
  normalizeInternalDocsHref,
  rewriteInternalDocsLinksInHtml,
  rewriteInternalDocsLinksInMarkdownAst,
  rewriteInternalDocsLinks,
} from '../apps/docs/lib/internal-doc-links'

describe('internal docs href normalization', () => {
  it('prefixes english docs links with docs basePath', () => {
    expect(normalizeInternalDocsHref('/en/docs/commands/status')).toBe(
      '/ragit/en/docs/commands/status'
    )
  })

  it('prefixes korean docs links with docs basePath', () => {
    expect(normalizeInternalDocsHref('/ko/docs/memory-model')).toBe(
      '/ragit/ko/docs/memory-model'
    )
  })

  it('preserves query strings and fragments', () => {
    expect(
      normalizeInternalDocsHref('/en/docs/commands/log?view=full#json')
    ).toBe('/ragit/en/docs/commands/log?view=full#json')
  })

  it('keeps already-prefixed docs links unchanged', () => {
    expect(normalizeInternalDocsHref('/ragit/en/docs/commands/status')).toBe(
      '/ragit/en/docs/commands/status'
    )
  })

  it('does not rewrite external, fragment-only, or relative links', () => {
    expect(normalizeInternalDocsHref('https://example.com/docs')).toBe(
      'https://example.com/docs'
    )
    expect(normalizeInternalDocsHref('mailto:docs@example.com')).toBe(
      'mailto:docs@example.com'
    )
    expect(normalizeInternalDocsHref('#section')).toBe('#section')
    expect(normalizeInternalDocsHref('./local')).toBe('./local')
  })

  it('rewrites anchor href values inside a rehype element tree', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            {
              type: 'element',
              tagName: 'a',
              properties: {
                href: '/en/docs/commands/status?view=full#json',
              },
              children: [],
            },
            {
              type: 'element',
              tagName: 'a',
              properties: {
                href: 'https://example.com/docs',
              },
              children: [],
            },
          ],
        },
      ],
    }

    rewriteInternalDocsLinks(tree)

    expect(tree.children[0].children[0].properties.href).toBe(
      '/ragit/en/docs/commands/status?view=full#json'
    )
    expect(tree.children[0].children[1].properties.href).toBe(
      'https://example.com/docs'
    )
  })

  it('rewrites raw html anchor href values for internal docs links', () => {
    expect(
      rewriteInternalDocsLinksInHtml(
        '<a href="/en/docs/commands/status?view=full#json">status</a>'
      )
    ).toBe(
      '<a href="/ragit/en/docs/commands/status?view=full#json">status</a>'
    )
  })

  it('rewrites markdown html nodes and mdx jsx anchor attributes', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'html',
          value: '<a href="/ko/docs/commands/log">log</a>',
        },
        {
          type: 'mdxJsxTextElement',
          name: 'a',
          attributes: [
            {
              type: 'mdxJsxAttribute',
              name: 'href',
              value: '/en/docs/commands/status',
            },
          ],
          children: [],
        },
      ],
    }

    rewriteInternalDocsLinksInMarkdownAst(tree)

    expect(tree.children[0].value).toBe(
      '<a href="/ragit/ko/docs/commands/log">log</a>'
    )
    expect((tree.children[1] as { attributes: Array<{ value: string }> }).attributes[0].value).toBe(
      '/ragit/en/docs/commands/status'
    )
  })
})

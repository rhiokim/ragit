import { docsBasePath } from './site'

const INTERNAL_DOCS_HREF_PATTERN = /^\/(en|ko)\/docs(?:[/?#].*)?$/u
const ABSOLUTE_SCHEME_PATTERN = /^[a-z][a-z\d+\-.]*:/iu

type HastNode = {
  type?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

type MdastAttribute = {
  type?: string
  name?: string
  value?: unknown
}

type MdastNode = {
  type?: string
  value?: string
  name?: string
  attributes?: MdastAttribute[]
  children?: MdastNode[]
}

function normalizeBasePath(value: string): string {
  return value === '/' ? '' : value.replace(/\/$/, '')
}

export function normalizeInternalDocsHref(href: string): string {
  const basePath = normalizeBasePath(docsBasePath)

  if (
    href === '' ||
    href.startsWith('#') ||
    href.startsWith('./') ||
    href.startsWith('../') ||
    ABSOLUTE_SCHEME_PATTERN.test(href) ||
    href.startsWith('//')
  ) {
    return href
  }

  if (
    (basePath !== '' && href === basePath) ||
    (basePath !== '' && href.startsWith(`${basePath}/`))
  ) {
    return href
  }

  if (!INTERNAL_DOCS_HREF_PATTERN.test(href)) {
    return href
  }

  return basePath === '' ? href : `${basePath}${href}`
}

export function rewriteInternalDocsLinksInHtml(raw: string): string {
  return raw.replace(/href=(['"])([^"'<>]+)\1/giu, (match, quote, href) => {
    const normalized = normalizeInternalDocsHref(href)
    return normalized === href ? match : `href=${quote}${normalized}${quote}`
  })
}

function visit(node: HastNode, visitor: (current: HastNode) => void): void {
  visitor(node)

  for (const child of node.children ?? []) {
    visit(child, visitor)
  }
}

export function rewriteInternalDocsLinks(tree: HastNode): void {
  visit(tree, (node) => {
    if (node.type !== 'element' || node.tagName !== 'a') {
      return
    }

    const href = node.properties?.href
    if (typeof href !== 'string') {
      return
    }

    const normalized = normalizeInternalDocsHref(href)
    if (normalized === href) {
      return
    }

    node.properties = {
      ...node.properties,
      href: normalized,
    }
  })
}

export function rehypeRewriteInternalDocsLinks() {
  return (tree: HastNode) => {
    rewriteInternalDocsLinks(tree)
  }
}

function visitMarkdown(node: MdastNode, visitor: (current: MdastNode) => void): void {
  visitor(node)

  for (const child of node.children ?? []) {
    visitMarkdown(child, visitor)
  }
}

export function rewriteInternalDocsLinksInMarkdownAst(tree: MdastNode): void {
  visitMarkdown(tree, (node) => {
    if (node.type === 'html' && typeof node.value === 'string') {
      node.value = rewriteInternalDocsLinksInHtml(node.value)
      return
    }

    if (
      (node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement') &&
      node.name === 'a'
    ) {
      for (const attribute of node.attributes ?? []) {
        if (
          attribute.type === 'mdxJsxAttribute' &&
          attribute.name === 'href' &&
          typeof attribute.value === 'string'
        ) {
          attribute.value = normalizeInternalDocsHref(attribute.value)
        }
      }
    }
  })
}

export function remarkRewriteInternalDocsLinks() {
  return (tree: MdastNode) => {
    rewriteInternalDocsLinksInMarkdownAst(tree)
  }
}

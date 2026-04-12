import { PackageManagerCodeBlock } from '@/components/package-manager-code-block';
import { MermaidDiagram } from '@/components/mermaid-diagram';
import {
  CodeBlock,
  type CodeBlockProps,
  Pre,
} from 'fumadocs-ui/components/codeblock';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { isValidElement } from 'react';

type CodePropsWithTabs = React.ComponentProps<'code'> & {
  __raw__?: string;
  __npm__?: string;
  __npm_display__?: string;
  __pnpm__?: string;
  __pnpm_display__?: string;
  __yarn__?: string;
  __yarn_display__?: string;
  __bun__?: string;
  __bun_display__?: string;
};

type PreProps = React.ComponentProps<'pre'> &
  Pick<CodeBlockProps, 'icon' | 'title'> & {
    children?: React.ReactNode;
  };

function hasPackageManagerTabs(props: CodePropsWithTabs) {
  return (
    typeof props.__npm__ === 'string' &&
    typeof props.__yarn__ === 'string' &&
    typeof props.__pnpm__ === 'string' &&
    typeof props.__bun__ === 'string'
  );
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
    MermaidDiagram,
    pre: ({ children, ...props }: PreProps) => {
      if (
        isValidElement<CodePropsWithTabs>(children) &&
        hasPackageManagerTabs(children.props)
      ) {
        return children;
      }

      return (
        <CodeBlock {...props}>
          <Pre className='px-4'>{children}</Pre>
        </CodeBlock>
      );
    },
    code: (
      {
        __npm__,
        __npm_display__,
        __pnpm__,
        __pnpm_display__,
        __yarn__,
        __yarn_display__,
        __bun__,
        __bun_display__,
        ...props
      }: CodePropsWithTabs
    ) => {
      if (
        typeof __npm__ === 'string' &&
        typeof __pnpm__ === 'string' &&
        typeof __yarn__ === 'string' &&
        typeof __bun__ === 'string'
      ) {
        return (
          <PackageManagerCodeBlock
            tabs={{
              pnpm: __pnpm__,
              npm: __npm__,
              yarn: __yarn__,
              bun: __bun__,
            }}
            displayTabs={{
              pnpm: typeof __pnpm_display__ === 'string' ? __pnpm_display__ : __pnpm__,
              npm: typeof __npm_display__ === 'string' ? __npm_display__ : __npm__,
              yarn: typeof __yarn_display__ === 'string' ? __yarn_display__ : __yarn__,
              bun: typeof __bun_display__ === 'string' ? __bun_display__ : __bun__,
            }}
          />
        );
      }

      return <code {...props} />;
    },
  };
}

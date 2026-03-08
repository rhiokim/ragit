import { PackageManagerCodeBlock } from '@/components/package-manager-code-block';
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
  __pnpm__?: string;
  __yarn__?: string;
  __bun__?: string;
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
    code: ({ __npm__, __pnpm__, __yarn__, __bun__, ...props }: CodePropsWithTabs) => {
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
          />
        );
      }

      return <code {...props} />;
    },
  };
}

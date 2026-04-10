'use client';

import type { MermaidConfig } from 'mermaid';
import { useEffect, useId, useRef, useState } from 'react';

type MermaidDiagramProps = {
  chart: string;
  caption?: string;
};

function pickColor(value: string | null | undefined, fallback: string) {
  if (!value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)') {
    return fallback;
  }

  return value;
}

function readThemeConfig(element: HTMLElement): MermaidConfig {
  const elementStyles = window.getComputedStyle(element);
  const bodyStyles = window.getComputedStyle(document.body);

  const background = pickColor(
    elementStyles.backgroundColor,
    pickColor(bodyStyles.backgroundColor, '#ffffff')
  );
  const text = pickColor(
    elementStyles.color,
    pickColor(bodyStyles.color, '#111827')
  );
  const border = pickColor(elementStyles.borderColor, text);
  const fontFamily =
    elementStyles.fontFamily || bodyStyles.fontFamily || 'ui-sans-serif, system-ui, sans-serif';

  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily,
    flowchart: {
      htmlLabels: false,
      useMaxWidth: false,
      curve: 'linear',
    },
    themeVariables: {
      background,
      primaryColor: background,
      primaryTextColor: text,
      primaryBorderColor: border,
      lineColor: text,
      clusterBkg: background,
      clusterBorder: border,
      tertiaryColor: background,
      mainBkg: background,
      nodeBorder: border,
      textColor: text,
      fontFamily,
    },
  };
}

export function MermaidDiagram({ chart, caption }: MermaidDiagramProps) {
  const id = useId().replace(/[:]/g, '');
  const figureRef = useRef<HTMLElement | null>(null);
  const [renderVersion, setRenderVersion] = useState(0);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    let frame = 0;
    const bumpVersion = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setRenderVersion((current) => current + 1);
      });
    };

    const observer = new MutationObserver(bumpVersion);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', bumpVersion);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      media.removeEventListener?.('change', bumpVersion);
    };
  }, []);

  useEffect(() => {
    const figure = figureRef.current;
    if (!figure) {
      return;
    }

    let cancelled = false;

    const renderChart = async () => {
      try {
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;
        mermaid.initialize(readThemeConfig(figure));

        const { svg: markup } = await mermaid.render(
          `mermaid-${id}-${renderVersion}`,
          chart
        );

        if (cancelled) {
          return;
        }

        setSvg(markup);
        setError(null);
      } catch (cause) {
        if (cancelled) {
          return;
        }

        setSvg(null);
        setError(
          cause instanceof Error ? cause.message : 'Failed to render Mermaid diagram.'
        );
      }
    };

    void renderChart();

    return () => {
      cancelled = true;
    };
  }, [chart, id, renderVersion]);

  return (
    <figure
      ref={figureRef}
      className="my-6 overflow-hidden rounded-xl border bg-fd-card text-fd-foreground shadow-sm"
    >
      <div className="overflow-x-auto px-4 py-4">
        {svg ? (
          <div
            className="min-w-fit [&_svg]:h-auto [&_svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : error ? (
          <div className="space-y-3">
            <p className="text-sm text-fd-muted-foreground">
              Mermaid rendering failed. Showing the source instead.
            </p>
            <pre className="overflow-x-auto rounded-lg border bg-fd-secondary/30 p-4 text-[0.8125rem] leading-6">
              <code>{chart}</code>
            </pre>
            <p className="text-xs text-fd-muted-foreground">{error}</p>
          </div>
        ) : (
          <p className="text-sm text-fd-muted-foreground">Rendering diagram...</p>
        )}
      </div>
      {caption ? (
        <figcaption className="border-t px-4 py-2 text-sm text-fd-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

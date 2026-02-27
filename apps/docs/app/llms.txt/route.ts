import { sources } from '@/lib/source';

export const revalidate = false;

export async function GET() {
  const lines: string[] = [];
  lines.push('# Documentation');
  lines.push('');
  lines.push('## English');
  for (const page of sources.en.getPages()) {
    lines.push(`- [${page.data.title}](${page.url}): ${page.data.description}`);
  }
  lines.push('');
  lines.push('## Korean');
  for (const page of sources.ko.getPages()) {
    lines.push(`- [${page.data.title}](${page.url}): ${page.data.description}`);
  }
  return new Response(lines.join('\n'));
}

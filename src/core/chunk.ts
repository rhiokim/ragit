import { createHash } from "node:crypto";
import { DocumentSection } from "./types.js";

const normalizeText = (text: string): string => text.replace(/\s+/g, " ").trim();

export const parseSections = (body: string): DocumentSection[] => {
  const lines = body.split(/\r?\n/);
  const sections: DocumentSection[] = [];
  let currentTitle = "Introduction";
  let currentLevel = 1;
  let currentBuffer: string[] = [];

  const flush = () => {
    const content = currentBuffer.join("\n").trim();
    if (!content) return;
    const raw = `${currentTitle}\n${content}`;
    const id = createHash("sha1").update(raw).digest("hex");
    sections.push({
      id,
      title: currentTitle,
      level: currentLevel,
      content,
    });
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentLevel = headingMatch[1].length;
      currentTitle = headingMatch[2].trim();
      currentBuffer = [];
      continue;
    }
    currentBuffer.push(line);
  }
  flush();
  return sections.length === 0
    ? [
        {
          id: createHash("sha1").update(body).digest("hex"),
          title: "Body",
          level: 1,
          content: body.trim(),
        },
      ]
    : sections;
};

export interface ChunkedSection {
  sectionId: string;
  sectionTitle: string;
  text: string;
  tokenCount: number;
}

const countTokens = (text: string): number => normalizeText(text).split(" ").filter(Boolean).length;

export const chunkSections = (sections: DocumentSection[], chunkSize = 1000, overlap = 120): ChunkedSection[] => {
  const chunks: ChunkedSection[] = [];
  for (const section of sections) {
    const content = section.content.trim();
    if (!content) continue;
    if (content.length <= chunkSize) {
      chunks.push({
        sectionId: section.id,
        sectionTitle: section.title,
        text: content,
        tokenCount: countTokens(content),
      });
      continue;
    }
    let cursor = 0;
    while (cursor < content.length) {
      const targetEnd = Math.min(content.length, cursor + chunkSize);
      let end = targetEnd;
      if (end < content.length) {
        const lastSpace = content.lastIndexOf(" ", end);
        if (lastSpace > cursor + Math.floor(chunkSize * 0.5)) {
          end = lastSpace;
        }
      }
      const chunkText = content.slice(cursor, end).trim();
      if (chunkText) {
        chunks.push({
          sectionId: section.id,
          sectionTitle: section.title,
          text: chunkText,
          tokenCount: countTokens(chunkText),
        });
      }
      if (end >= content.length) break;
      cursor = Math.max(end - overlap, cursor + 1);
    }
  }
  return chunks;
};

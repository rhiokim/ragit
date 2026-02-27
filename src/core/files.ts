import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import fg from "fast-glob";
import { listChangedFilesSince } from "./git.js";

const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx"]);

const normalizeAbsolutePaths = (cwd: string, files: string[]): string[] => {
  const seen = new Set<string>();
  const absolute: string[] = [];
  for (const file of files) {
    const target = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    if (!seen.has(target)) {
      seen.add(target);
      absolute.push(target);
    }
  }
  return absolute;
};

const filterDocumentLike = (files: string[]): string[] =>
  files.filter((file) => DOCUMENT_EXTENSIONS.has(path.extname(file).toLowerCase()));

const defaultIgnore = ["**/.git/**", "**/.ragit/**", "**/node_modules/**", "**/dist/**"];

export const listAllDocumentFiles = async (cwd: string): Promise<string[]> => {
  const files = await fg(["**/*.md", "**/*.mdx"], {
    cwd,
    ignore: defaultIgnore,
    dot: false,
    onlyFiles: true,
  });
  return normalizeAbsolutePaths(cwd, files);
};

export const listDocumentFilesByGlob = async (cwd: string, globText: string): Promise<string[]> => {
  const patterns = globText
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (patterns.length === 0) return [];
  const files = await fg(patterns, {
    cwd,
    ignore: defaultIgnore,
    dot: false,
    onlyFiles: true,
  });
  return normalizeAbsolutePaths(cwd, filterDocumentLike(files));
};

export const listDocumentFilesSince = async (cwd: string, since: string): Promise<string[]> => {
  const changed = await listChangedFilesSince(cwd, since);
  return normalizeAbsolutePaths(cwd, filterDocumentLike(changed));
};

export const hashFileContent = async (absolutePath: string): Promise<{ content: string; hash: string }> => {
  const content = await readFile(absolutePath, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  return { content, hash };
};

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SnapshotManifest, ChunkRecord, DocumentRecord } from "./types.js";

const manifestDir = (cwd: string): string => path.join(cwd, ".ragit", "manifest");

const manifestPath = (cwd: string, sha: string): string => path.join(manifestDir(cwd), `${sha}.json`);

export const buildSnapshotManifest = (
  commitSha: string,
  parentSha: string | null,
  docs: DocumentRecord[],
  chunks: ChunkRecord[],
): SnapshotManifest => ({
  commitSha,
  parentSha,
  createdAt: new Date().toISOString(),
  indexVersion: 1,
  docs,
  chunks: chunks.map((chunk) => ({
    id: chunk.id,
    documentId: chunk.documentId,
  })),
});

export const writeSnapshotManifest = async (cwd: string, manifest: SnapshotManifest): Promise<void> => {
  const target = manifestPath(cwd, manifest.commitSha);
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
};

export const loadSnapshotManifest = async (cwd: string, sha: string): Promise<SnapshotManifest> => {
  const target = manifestPath(cwd, sha);
  const content = await readFile(target, "utf8");
  return JSON.parse(content) as SnapshotManifest;
};

export const latestSnapshotSha = async (cwd: string): Promise<string | null> => {
  const dir = manifestDir(cwd);
  const files = await readdir(dir);
  const manifests = files
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      sha: name.replace(/\.json$/, ""),
      name,
    }))
    .sort((a, b) => b.name.localeCompare(a.name));
  return manifests[0]?.sha ?? null;
};

export const resolveSnapshotRef = async (cwd: string, ref: string): Promise<string> => {
  const dir = manifestDir(cwd);
  const files = await readdir(dir);
  const exact = files.find((name) => name === `${ref}.json`);
  if (exact) return ref;
  const byPrefix = files.filter((name) => name.startsWith(ref) && name.endsWith(".json"));
  if (byPrefix.length === 1) return byPrefix[0].replace(/\.json$/, "");
  if (byPrefix.length > 1) {
    throw new Error(`snapshot ref가 모호합니다: ${ref}`);
  }
  throw new Error(`snapshot을 찾을 수 없습니다: ${ref}`);
};

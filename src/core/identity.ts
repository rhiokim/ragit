import { createHash } from "node:crypto";
import path from "node:path";

export const toRepoPath = (cwd: string, targetPath: string): string =>
  path.relative(cwd, targetPath).replaceAll(path.sep, "/");

export const documentIdFromPath = (repoPath: string): string => createHash("sha1").update(repoPath).digest("hex");

export const documentVersionId = (documentId: string, commitSha: string, hash: string): string =>
  createHash("sha1").update(`${documentId}:${commitSha}:${hash}`).digest("hex");

export const chunkVersionId = (documentVersion: string, sectionId: string, index: number, text: string): string =>
  createHash("sha1").update(`${documentVersion}:${sectionId}:${index}:${text}`).digest("hex");

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { deriveLogSemanticOverlay } from "../src/core/logSemantic.js";
import { loadSnapshotManifest } from "../src/core/manifest.js";

describe("manifest compatibility", () => {
  it("backfills v2 manifests into v3 chunk scopes", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-manifest-v2-"));
    await runInit(temp, { nonInteractive: true, gitInit: true });

    await mkdir(path.join(temp, ".ragit", "manifest"), { recursive: true });
    await writeFile(
      path.join(temp, ".ragit", "manifest", "abc123.json"),
      `${JSON.stringify(
        {
          commitSha: "abc123",
          parentSha: null,
          createdAt: "2026-04-09T12:00:00.000Z",
          indexVersion: 2,
          docs: [
            {
              id: "doc_readme",
              versionId: "doc_readme:abc123",
              path: "README.md",
              docType: "plan",
              commitSha: "abc123",
              hash: "hash",
              sections: [],
            },
          ],
          chunks: [{ id: "chunk-1", documentId: "doc_readme", documentVersionId: "doc_readme:abc123" }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const manifest = await loadSnapshotManifest(temp, "abc123");
    expect(manifest.indexVersion).toBe(3);
    expect(manifest.artifactEntries).toEqual([]);
    expect(manifest.chunkScopes).toBeTruthy();
    expect(manifest.chunkScopes!.durable).toEqual(["chunk-1"]);
    expect(manifest.chunkScopes!.session).toEqual([]);
    expect(manifest.chunkScopes!.harness).toEqual([]);
    expect(manifest.chunkScopes!.evidence).toEqual([]);

    const semantic = await deriveLogSemanticOverlay(temp, manifest);
    expect(semantic.available).toBe(true);
    expect(semantic.counts.artifacts).toBe(0);
    expect(semantic.headline).toContain("No artifact-backed semantic overlays");
  });
});

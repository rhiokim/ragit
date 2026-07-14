import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { deriveLogSemanticOverlay } from "../src/core/logSemantic.js";
import {
  listSnapshotShas,
  loadSnapshotManifest,
  loadSnapshotManifestIfExists,
  snapshotManifestExists,
} from "../src/core/manifest.js";

const manifestPath = (cwd: string, sha: string): string =>
  path.join(cwd, ".ragit", "manifest", `${sha}.json`);

const writeRawManifest = async (cwd: string, sha: string, value: unknown): Promise<string> => {
  await mkdir(path.dirname(manifestPath(cwd, sha)), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(manifestPath(cwd, sha), content, "utf8");
  return content;
};

const v3Manifest = (commitSha = "abc123"): Record<string, unknown> => ({
  commitSha,
  parentSha: null,
  createdAt: "2026-04-09T12:00:00.000Z",
  indexVersion: 3,
  docs: [],
  chunks: [],
});

const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code });
};

describe("manifest compatibility", () => {
  it("backfills v2 manifests in memory without rewriting the legacy file", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-manifest-v2-"));
    await runInit(temp, { nonInteractive: true, gitInit: true });

    const original = await writeRawManifest(temp, "abc123", {
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
    });

    const manifest = await loadSnapshotManifest(temp, "abc123");
    expect(manifest.indexVersion).toBe(3);
    expect(manifest.artifactEntries).toEqual([]);
    expect(manifest.chunkScopes).toEqual({
      durable: ["chunk-1"],
      session: [],
      harness: [],
      evidence: [],
    });
    expect(await readFile(manifestPath(temp, "abc123"), "utf8")).toBe(original);

    const semantic = await deriveLogSemanticOverlay(temp, manifest);
    expect(semantic.available).toBe(true);
    expect(semantic.counts.artifacts).toBe(0);
    expect(semantic.headline).toContain("No artifact-backed semantic overlays");
  });

  it("accepts v3 manifests and defaults missing additive arrays", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-manifest-v3-"));
    await writeRawManifest(temp, "abc123", v3Manifest());

    await expect(loadSnapshotManifest(temp, "abc123")).resolves.toMatchObject({
      commitSha: "abc123",
      indexVersion: 3,
      artifactEntries: [],
      chunkScopes: {
        durable: [],
        session: [],
        harness: [],
        evidence: [],
      },
    });
  });

  it("rejects future manifest schemas with a typed incompatibility", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-manifest-future-"));
    await writeRawManifest(temp, "abc123", {
      commitSha: "abc123",
      parentSha: null,
      createdAt: "2026-04-09T12:00:00.000Z",
      indexVersion: 4,
    });

    await expectCode(loadSnapshotManifest(temp, "abc123"), "SNAPSHOT_SCHEMA_UNSUPPORTED");
    await expectCode(loadSnapshotManifestIfExists(temp, "abc123"), "SNAPSHOT_SCHEMA_UNSUPPORTED");
  });

  it("rejects a filename and commitSha mismatch", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-manifest-mismatch-"));
    await writeRawManifest(temp, "abc123", v3Manifest("def456"));

    await expectCode(loadSnapshotManifest(temp, "abc123"), "SNAPSHOT_MANIFEST_INVALID");
  });

  it("rejects truncated JSON and rethrows corruption from the optional loader", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-manifest-corrupt-"));
    await mkdir(path.dirname(manifestPath(temp, "abc123")), { recursive: true });
    await writeFile(manifestPath(temp, "abc123"), '{"commitSha":"abc123"', "utf8");

    await expectCode(loadSnapshotManifest(temp, "abc123"), "SNAPSHOT_MANIFEST_INVALID");
    await expectCode(loadSnapshotManifestIfExists(temp, "abc123"), "SNAPSHOT_MANIFEST_INVALID");
  });

  it.each([
    ["non-object root", null],
    ["missing commitSha", { ...v3Manifest(), commitSha: undefined }],
    ["missing parentSha", { ...v3Manifest(), parentSha: undefined }],
    ["missing createdAt", { ...v3Manifest(), createdAt: undefined }],
    ["missing indexVersion", { ...v3Manifest(), indexVersion: undefined }],
    ["non-array docs", { ...v3Manifest(), docs: {} }],
    ["non-array chunks", { ...v3Manifest(), chunks: {} }],
    ["non-array artifactEntries", { ...v3Manifest(), artifactEntries: {} }],
    ["non-array chunk scope", { ...v3Manifest(), chunkScopes: { durable: {} } }],
  ])("rejects %s as an invalid manifest", async (_label, value) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-manifest-shape-"));
    await writeRawManifest(temp, "abc123", value);

    await expectCode(loadSnapshotManifest(temp, "abc123"), "SNAPSHOT_MANIFEST_INVALID");
  });

  it("treats a missing manifest directory as an empty catalog", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-manifest-missing-"));

    await expect(listSnapshotShas(temp)).resolves.toEqual([]);
    await expect(snapshotManifestExists(temp, "abc123")).resolves.toBe(false);
    await expectCode(loadSnapshotManifest(temp, "abc123"), "SNAPSHOT_NOT_INDEXED");
    await expect(loadSnapshotManifestIfExists(temp, "abc123")).resolves.toBeNull();
    await expect(loadSnapshotManifestIfExists(temp, null)).resolves.toBeNull();
  });
});

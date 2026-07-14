import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSnapshotManifest,
  listSnapshotShas,
  writeSnapshotManifest,
} from "../src/core/manifest.js";

describe("atomic manifest publication", () => {
  it("lists only final JSON manifests and ignores temporary files", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-manifest-list-"));
    const directory = path.join(temp, ".ragit", "manifest");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "abc123.json"), "{}\n", "utf8");
    await writeFile(path.join(directory, "abc123.json.42.partial.tmp"), "{", "utf8");
    await writeFile(path.join(directory, "def456.tmp"), "{", "utf8");

    await expect(listSnapshotShas(temp)).resolves.toEqual(["abc123"]);
  });

  it("publishes one complete manifest and leaves no temporary file", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-manifest-write-"));
    const manifest = buildSnapshotManifest("abc123", null, [], []);

    await writeSnapshotManifest(temp, manifest);

    const ragitEntries = await readdir(path.join(temp, ".ragit"));
    expect(ragitEntries).toEqual(["manifest"]);

    const directory = path.join(temp, ".ragit", "manifest");
    const entries = await readdir(directory);
    expect(entries).toEqual(["abc123.json"]);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);

    const published = JSON.parse(await readFile(path.join(directory, "abc123.json"), "utf8"));
    expect(published).toEqual(manifest);
  });
});

import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig, setConfigValue, writeConfig } from "../core/config.js";
import { ensureGitRepository, currentBranch, getHeadSha } from "../core/git.js";
import { loadSnapshotManifest } from "../core/manifest.js";
import { ensureRagitStructure, resolveRagitPaths } from "../core/project.js";
import { bootstrapCanonicalStore, closeCanonicalStore, hasLegacyJsonStore, isZvecPlatformSupported } from "../core/store.js";

export const runConfigSet = async (cwd: string, key: string, value: string): Promise<void> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const updated = setConfigValue(config, key, value);
  await writeConfig(cwd, updated);
  console.log(`설정이 업데이트되었습니다: ${key}=${value}`);
};

export interface StatusResult {
  branch: string;
  head: string;
  backend: string;
  zvec: {
    status: "missing" | "loaded";
    collections: string[];
    schemaVersion: number | null;
    searchReady: boolean;
    migrationRequired: boolean;
    stats: Record<string, unknown> | null;
  };
  supported_types: string[];
  manifests: number;
  embedding: Awaited<ReturnType<typeof loadConfig>>["embedding"];
  format: Awaited<ReturnType<typeof loadConfig>>["output"]["format"];
}

export const runStatus = async (cwd: string): Promise<StatusResult> => {
  await ensureRagitStructure(cwd);
  const paths = resolveRagitPaths(cwd);
  const config = await loadConfig(cwd);
  const manifests = (await readdir(paths.manifestDir)).filter((name) => name.endsWith(".json"));
  const branch = await currentBranch(cwd);
  const sha = await getHeadSha(cwd);
  let zvecStatus: "missing" | "loaded" = "missing";
  let collections: string[] = [];
  let schemaVersion: number | null = null;
  let stats: Record<string, unknown> | null = null;
  try {
    const store = await bootstrapCanonicalStore(cwd, config.embedding, true);
    try {
      zvecStatus = "loaded";
      collections = [store.meta.collections.documents, store.meta.collections.chunks];
      schemaVersion = store.meta.schemaVersion;
      stats = {
        documents: store.documents.stats,
        chunks: store.chunks.stats,
      };
    } finally {
      closeCanonicalStore(store);
    }
  } catch {
    zvecStatus = "missing";
  }
  const status = {
    branch,
    head: sha,
    backend: config.storage.backend,
    zvec: {
      status: zvecStatus,
      collections,
      schemaVersion,
      searchReady: manifests.length > 0,
      migrationRequired: await hasLegacyJsonStore(cwd),
      stats,
    },
    supported_types: config.ingest.supported_types,
    manifests: manifests.length,
    embedding: config.embedding,
    format: config.output.format,
  };
  return status;
};

const checkManifestConsistency = async (
  cwd: string,
  manifestFiles: string[],
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<{ manifests: number; missingChunkIds: number }> => {
  if (manifestFiles.length === 0) {
    return {
      manifests: 0,
      missingChunkIds: 0,
    };
  }
  const store = await bootstrapCanonicalStore(cwd, config.embedding, true);
  try {
    const manifestChunkIds = new Set<string>();
    for (const fileName of manifestFiles) {
      const manifest = await loadSnapshotManifest(cwd, fileName.replace(/\.json$/, ""));
      for (const chunk of manifest.chunks) {
        manifestChunkIds.add(chunk.id);
      }
    }
    if (manifestChunkIds.size === 0) {
      return {
        manifests: manifestFiles.length,
        missingChunkIds: 0,
      };
    }
    const fetched = store.chunks.fetchSync(Array.from(manifestChunkIds));
    return {
      manifests: manifestFiles.length,
      missingChunkIds: manifestChunkIds.size - Object.keys(fetched).length,
    };
  } finally {
    closeCanonicalStore(store);
  }
};

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  hasFailure: boolean;
}

export const runDoctor = async (cwd: string): Promise<DoctorResult> => {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  try {
    await ensureGitRepository(cwd);
    checks.push({ name: "git.repository", ok: true, detail: "저장소 확인 완료" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: "git.repository", ok: false, detail: message });
  }
  try {
    const paths = await ensureRagitStructure(cwd);
    const manifests = (await readdir(paths.manifestDir)).filter((name) => name.endsWith(".json"));
    checks.push({ name: "ragit.structure", ok: true, detail: `manifest=${manifests.length}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: "ragit.structure", ok: false, detail: message });
  }
  const config = await (async () => {
    try {
      const loaded = await loadConfig(cwd);
      checks.push({
        name: "ragit.config",
        ok: true,
        detail: `backend=${loaded.storage.backend}, embedding=${loaded.embedding.provider}/${loaded.embedding.version}/${loaded.embedding.dimensions}`,
      });
      return loaded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name: "ragit.config", ok: false, detail: message });
      return null;
    }
  })();
  try {
    checks.push({
      name: "zvec.platform",
      ok: isZvecPlatformSupported(),
      detail: isZvecPlatformSupported() ? `${process.platform}/${process.arch}` : `${process.platform}/${process.arch} unsupported`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: "zvec.platform", ok: false, detail: message });
  }
  if (config) {
    try {
      const store = await bootstrapCanonicalStore(cwd, config.embedding, true);
      try {
        checks.push({
          name: "zvec.runtime",
          ok: true,
          detail: `collections=${store.meta.collections.documents},${store.meta.collections.chunks}`,
        });
        checks.push({
          name: "zvec.schema",
          ok: true,
          detail: `layout=${store.meta.layoutVersion}, schema=${store.meta.schemaVersion}`,
        });
        checks.push({
          name: "zvec.embedding",
          ok: true,
          detail: `${store.meta.embeddingContract.provider}/${store.meta.embeddingContract.version}/${store.meta.embeddingContract.dimensions}`,
        });
      } finally {
        closeCanonicalStore(store);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name: "zvec.runtime", ok: false, detail: message });
    }
    try {
      const paths = resolveRagitPaths(cwd);
      const manifests = (await readdir(paths.manifestDir)).filter((name) => name.endsWith(".json"));
      const consistency = await checkManifestConsistency(cwd, manifests, config);
      checks.push({
        name: "ragit.manifest-consistency",
        ok: consistency.missingChunkIds === 0,
        detail: `manifests=${consistency.manifests}, missingChunkIds=${consistency.missingChunkIds}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name: "ragit.manifest-consistency", ok: false, detail: message });
    }
    try {
      const migrationRequired = await hasLegacyJsonStore(cwd);
      checks.push({
        name: "ragit.legacy-json-store",
        ok: true,
        detail: migrationRequired ? "migration required" : "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name: "ragit.legacy-json-store", ok: false, detail: message });
    }
  }
  const hasFailure = checks.some((check) => !check.ok);
  return { checks, hasFailure };
};

export const resolveCwd = (input?: string): string => (input ? path.resolve(input) : process.cwd());

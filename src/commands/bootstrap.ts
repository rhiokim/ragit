import { readdir } from "node:fs/promises";
import path from "node:path";
import { countArtifactState } from "../core/artifacts.js";
import { loadConfig, setConfigValue, writeConfig } from "../core/config.js";
import { readDocAuthorityIndex } from "../core/doc-authority.js";
import {
  checkEmbeddingCacheHealth,
  EmbeddingProviderError,
  readEmbeddingCacheSummary,
  resolveEmbeddingConfiguredState,
  resolveEmbeddingProfile,
  toEmbeddingContract,
} from "../core/embedding.js";
import { isRagitOperationalError } from "../core/errors.js";
import { readEventLedgerStats } from "../core/event-ledger.js";
import { ensureGitRepository, tryGetGitRoot } from "../core/git.js";
import { loadSnapshotManifest } from "../core/manifest.js";
import { ensureRagitStructure, resolveRagitPaths } from "../core/project.js";
import {
  classifyEmbeddingEgress,
  readAdmissionStats,
  countQuarantineEntries,
  readSecurityState,
  runSecurityAudit,
} from "../core/security.js";
import {
  bootstrapCanonicalStore,
  closeCanonicalStore,
  formatZvecPlatformSupport,
  getZvecPlatformSupport,
  hasLegacyJsonStore,
  readCanonicalStoreMeta,
} from "../core/store.js";
import { resolveRepositoryContext, type SnapshotMetadata } from "../core/snapshot.js";

export const runConfigSet = async (cwd: string, key: string, value: string): Promise<void> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const updated = setConfigValue(config, key, value);
  await writeConfig(cwd, updated);
  console.log(`설정이 업데이트되었습니다: ${key}=${value}`);
};

type StatusEmbeddingState = {
  configured: ReturnType<typeof resolveEmbeddingProfile>;
  store: {
    provider: string;
    dimensions: number;
    version: string;
    schemaVersion: number;
  } | null;
  cache: Awaited<ReturnType<typeof readEmbeddingCacheSummary>>;
  ready: boolean;
  needsMigration: boolean;
};

const hasCredentialForProfile = (profile: ReturnType<typeof resolveEmbeddingProfile>): boolean =>
  profile.provider !== "openai" || Boolean(process.env.OPENAI_API_KEY?.trim());

const hasReadableStoreMeta = (
  storeMeta: Awaited<ReturnType<typeof readCanonicalStoreMeta>>,
): storeMeta is NonNullable<Awaited<ReturnType<typeof readCanonicalStoreMeta>>> => {
  if (typeof storeMeta !== "object" || storeMeta === null) return false;
  const candidate = storeMeta as unknown as Record<string, unknown>;
  const contract = candidate.embeddingContract;
  if (typeof contract !== "object" || contract === null) return false;
  const embeddingContract = contract as Record<string, unknown>;
  return (
    typeof candidate.schemaVersion === "number" &&
    typeof embeddingContract.provider === "string" &&
    typeof embeddingContract.dimensions === "number" &&
    typeof embeddingContract.version === "string"
  );
};

const embeddingNeedsMigration = (
  profile: ReturnType<typeof resolveEmbeddingProfile>,
  storeMeta: Awaited<ReturnType<typeof readCanonicalStoreMeta>>,
): boolean =>
  storeMeta !== null &&
  (storeMeta.embeddingContract.provider !== profile.provider ||
    storeMeta.embeddingContract.dimensions !== profile.dimensions ||
    storeMeta.embeddingContract.version !== profile.version);

export interface StatusResult {
  branch: string | null;
  head: string | null;
  snapshot: SnapshotMetadata;
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
  docsAuthority: {
    tracked: number;
    violations: number;
    lastReconciledAt: string | null;
    indexPath: string;
  };
  knowledge: {
    durableReady: boolean;
    sessionArtifactCount: number;
    harnessArtifactCount: number;
    pendingBindings: number;
  };
  events: {
    eventCount: number;
    lastRecordedAt: string | null;
    latestEpisodeId: string | null;
    latestGoalId: string | null;
    latestSessionId: string | null;
  };
  manifests: number;
  embedding: StatusEmbeddingState;
  security: {
    maskingConfigured: boolean;
    remoteEmbeddingPolicy: Awaited<ReturnType<typeof loadConfig>>["security"]["remote_embedding_policy"];
    admissionMode: Awaited<ReturnType<typeof loadConfig>>["security"]["admission_mode"];
    providerEgressClass: "local" | "remote";
    outputRemasking: boolean;
    quarantineEntries: number;
    lastAdmissionAt: string | null;
    admissionBlockedEntries: number;
    admissionQuarantinedEntries: number;
    lastAuditAt: string | null;
    legacyUnsafeState: boolean;
  };
  format: Awaited<ReturnType<typeof loadConfig>>["output"]["format"];
}

export const runStatus = async (cwd: string): Promise<StatusResult> => {
  const context = await resolveRepositoryContext(cwd);
  cwd = context.gitRoot;
  await ensureRagitStructure(cwd);
  const paths = resolveRagitPaths(cwd);
  const config = await loadConfig(cwd);
  const configuredProfile = resolveEmbeddingProfile(config);
  const rawStoreMeta = await readCanonicalStoreMeta(cwd);
  const storeMeta = hasReadableStoreMeta(rawStoreMeta) ? rawStoreMeta : null;
  const cache = await readEmbeddingCacheSummary(cwd, configuredProfile);
  const needsMigration = embeddingNeedsMigration(configuredProfile, storeMeta);
  const securityState = await readSecurityState(cwd);
  const quarantineEntries = await countQuarantineEntries(cwd);
  const admissionStats = await readAdmissionStats(cwd);
  const manifests = (await readdir(paths.manifestDir)).filter((name) => name.endsWith(".json"));
  let exactManifestState: "missing" | "invalid" | "valid" = context.headSha === null ? "missing" : "valid";
  if (context.headSha !== null) {
    try {
      await loadSnapshotManifest(cwd, context.headSha);
    } catch (error) {
      if (!isRagitOperationalError(error)) throw error;
      if (error.code === "SNAPSHOT_NOT_INDEXED") {
        exactManifestState = "missing";
      } else if (error.code === "SNAPSHOT_MANIFEST_INVALID" || error.code === "SNAPSHOT_SCHEMA_UNSUPPORTED") {
        exactManifestState = "invalid";
      } else {
        throw error;
      }
    }
  }
  let zvecStatus: "missing" | "loaded" = "missing";
  let collections: string[] = [];
  let schemaVersion: number | null = null;
  let stats: Record<string, unknown> | null = null;
  try {
    const store = await bootstrapCanonicalStore(cwd, toEmbeddingContract(configuredProfile), true);
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
  const snapshotStatus: SnapshotMetadata["status"] =
    exactManifestState === "missing"
      ? "missing"
      : exactManifestState === "invalid"
        ? "invalid"
        : zvecStatus === "loaded"
          ? "indexed"
          : "store-unavailable";
  const snapshot: SnapshotMetadata = {
    requestedRef: "HEAD",
    resolvedSha: context.headSha,
    selection: "head-exact",
    status: snapshotStatus,
    branch: context.branch,
    detached: context.detached,
    worktreeDirty: context.worktreeDirty,
  };
  const snapshotReady = snapshotStatus === "indexed";
  const status: StatusResult = {
    branch: context.branch,
    head: context.headSha,
    snapshot,
    backend: config.storage.backend,
    zvec: {
      status: zvecStatus,
      collections,
      schemaVersion,
      searchReady: snapshotReady,
      migrationRequired: await hasLegacyJsonStore(cwd),
      stats,
    },
    supported_types: config.ingest.supported_types,
    docsAuthority: {
      tracked: 0,
      violations: 0,
      lastReconciledAt: null,
      indexPath: ".ragit/docs/index.json",
    },
    knowledge: {
      durableReady: snapshotReady,
      sessionArtifactCount: 0,
      harnessArtifactCount: 0,
      pendingBindings: 0,
    },
    events: {
      eventCount: 0,
      lastRecordedAt: null,
      latestEpisodeId: null,
      latestGoalId: null,
      latestSessionId: null,
    },
    manifests: manifests.length,
    embedding: {
      configured: configuredProfile,
      store: storeMeta
        ? {
            provider: storeMeta.embeddingContract.provider,
            dimensions: storeMeta.embeddingContract.dimensions,
            version: storeMeta.embeddingContract.version,
            schemaVersion: storeMeta.schemaVersion,
          }
        : null,
      cache,
      ready: hasCredentialForProfile(configuredProfile) && !needsMigration,
      needsMigration,
    },
    security: {
      maskingConfigured: config.security.secret_masking,
      remoteEmbeddingPolicy: config.security.remote_embedding_policy,
      admissionMode: config.security.admission_mode,
      providerEgressClass: classifyEmbeddingEgress(configuredProfile),
      outputRemasking: true,
      quarantineEntries,
      lastAdmissionAt: admissionStats.lastAdmissionAt,
      admissionBlockedEntries: admissionStats.blocked,
      admissionQuarantinedEntries: admissionStats.quarantined,
      lastAuditAt: securityState?.lastAuditAt ?? null,
      legacyUnsafeState: securityState?.legacyUnsafeState ?? false,
    },
    format: config.output.format,
  };
  const docAuthorityIndex = await readDocAuthorityIndex(cwd);
  status.docsAuthority = docAuthorityIndex
    ? {
        tracked: docAuthorityIndex.tracked,
        violations: docAuthorityIndex.violations,
        lastReconciledAt: docAuthorityIndex.lastReconciledAt,
        indexPath: ".ragit/docs/index.json",
      }
    : status.docsAuthority;
  status.knowledge = {
    durableReady: snapshotReady,
    ...(await countArtifactState(cwd)),
  };
  status.events = await readEventLedgerStats(cwd);
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
  const storeMeta = await readCanonicalStoreMeta(cwd);
  if (!storeMeta) {
    return {
      manifests: manifestFiles.length,
      missingChunkIds: 0,
    };
  }
  const store = await bootstrapCanonicalStore(cwd, storeMeta.embeddingContract, true);
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
      const profile = resolveEmbeddingProfile(loaded);
      checks.push({
        name: "ragit.config",
        ok: true,
        detail: `backend=${loaded.storage.backend}, embedding=${profile.provider}/${profile.model}/${profile.version}/${profile.dimensions}`,
      });
      return loaded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name: "ragit.config", ok: false, detail: message });
      return null;
    }
  })();
  try {
    const support = getZvecPlatformSupport();
    checks.push({
      name: "zvec.platform",
      ok: support.supported,
      detail: formatZvecPlatformSupport(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: "zvec.platform", ok: false, detail: message });
  }
  if (config) {
    const configuredState = resolveEmbeddingConfiguredState(config);
    let profile: ReturnType<typeof resolveEmbeddingProfile> | null = null;
    try {
      profile = resolveEmbeddingProfile(config);
      checks.push({
        name: "embedding.config",
        ok: true,
        detail: `${profile.provider}/${profile.model}/${profile.version}/${profile.dimensions}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name: "embedding.config", ok: false, detail: message });
    }
    checks.push({
      name: "embedding.credentials",
      ok: profile ? hasCredentialForProfile(profile) : false,
      detail:
        profile?.provider === "openai"
          ? hasCredentialForProfile(profile)
            ? "OPENAI_API_KEY present"
            : "OPENAI_API_KEY missing"
          : "not required",
    });
    checks.push({
      name: "embedding.deprecated-fields",
      ok: !(
        configuredState.provider !== "local-placeholder" &&
        (configuredState.deprecatedDimensions !== null || configuredState.deprecatedVersion !== null)
      ),
      detail:
        configuredState.provider === "local-placeholder"
          ? "none"
          : [
              configuredState.deprecatedDimensions !== null ? "dimensions ignored" : null,
              configuredState.deprecatedVersion !== null ? "version ignored" : null,
            ]
              .filter(Boolean)
              .join(", ") || "none",
    });
    const storeMeta = await readCanonicalStoreMeta(cwd);
    const migrationNeeded = profile ? embeddingNeedsMigration(profile, storeMeta) : false;
    checks.push({
      name: "embedding.contract",
      ok: !migrationNeeded,
      detail:
        storeMeta === null
          ? "store meta missing"
          : `store=${storeMeta.embeddingContract.provider}/${storeMeta.embeddingContract.version}/${storeMeta.embeddingContract.dimensions}`,
    });
    checks.push({
      name: "embedding.migration-needed",
      ok: !migrationNeeded,
      detail: migrationNeeded ? "run ragit migrate embeddings" : "none",
    });
    if (profile) {
      const egressClass = classifyEmbeddingEgress(profile);
      checks.push({
        name: "security.masking-config",
        ok: config.security.secret_masking,
        detail: `secret_masking=${config.security.secret_masking}`,
      });
      checks.push({
        name: "security.output-remasking",
        ok: true,
        detail: "enabled",
      });
      checks.push({
        name: "security.remote-egress",
        ok: !(config.security.remote_embedding_policy === "local-only" && egressClass === "remote"),
        detail: `policy=${config.security.remote_embedding_policy}, class=${egressClass}`,
      });
      const quarantineEntries = await countQuarantineEntries(cwd);
      const admissionStats = await readAdmissionStats(cwd);
      checks.push({
        name: "security.quarantine-dir",
        ok: true,
        detail: `entries=${quarantineEntries}`,
      });
      checks.push({
        name: "security.admission-mode",
        ok: config.security.admission_mode === "enforce",
        detail:
          config.security.admission_mode === "enforce"
            ? "enforce"
            : "report-only (legacy fallback 또는 명시적 완화 모드)",
      });
      checks.push({
        name: "security.admission-recent-blocked",
        ok: admissionStats.blocked === 0,
        detail: `blocked=${admissionStats.blocked}, quarantined=${admissionStats.quarantined}, last=${admissionStats.lastAdmissionAt ?? "none"}`,
      });
      const cacheHealth = await checkEmbeddingCacheHealth(cwd, profile);
      checks.push({
        name: "embedding.cache-dir",
        ok:
          !cacheHealth.enabled ||
          (!cacheHealth.invalidConfig && cacheHealth.writable),
        detail:
          !cacheHealth.enabled
            ? "disabled"
            : cacheHealth.invalidConfig
              ? `invalid cache_dir: ${cacheHealth.dir}`
              : `dir=${cacheHealth.dir}, writable=${cacheHealth.writable}`,
      });
      checks.push({
        name: "embedding.cache-namespace",
        ok:
          !cacheHealth.enabled ||
          (!cacheHealth.invalidConfig && (cacheHealth.namespaceReadable || cacheHealth.entryCount === 0)),
        detail:
          !cacheHealth.enabled
            ? "disabled"
            : cacheHealth.invalidConfig
              ? "cache namespace unavailable because cache_dir is invalid"
              : `namespace=${cacheHealth.namespaceId ?? "none"}, entries=${cacheHealth.entryCount}, manifest=${cacheHealth.namespaceReadable ? "readable" : "missing"}`,
      });
    }
    try {
      if (!storeMeta) {
        throw new Error("zvec store가 아직 초기화되지 않았습니다.");
      }
      const store = await bootstrapCanonicalStore(cwd, storeMeta.embeddingContract, true);
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
      const message =
        error instanceof EmbeddingProviderError || error instanceof Error ? error.message : String(error);
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
    try {
      const securityAudit = await runSecurityAudit(cwd);
      checks.push({
        name: "security.legacy-control-plane",
        ok: securityAudit.summary.legacyControlPlaneFiles === 0,
        detail: `flagged=${securityAudit.summary.legacyControlPlaneFiles}`,
      });
      checks.push({
        name: "security.legacy-store",
        ok: securityAudit.summary.legacyStoreFindings === 0,
        detail: `flagged=${securityAudit.summary.legacyStoreFindings}`,
      });
      checks.push({
        name: "security.audit-admission",
        ok: securityAudit.summary.admissionBlocked === 0,
        detail: `blocked=${securityAudit.summary.admissionBlocked}, quarantined=${securityAudit.summary.admissionQuarantined}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name: "security.audit", ok: false, detail: message });
    }
  }
  const hasFailure = checks.some((check) => !check.ok);
  return { checks, hasFailure };
};

export const resolveCwd = async (input?: string): Promise<string> => {
  const requested = input ? path.resolve(input) : process.cwd();
  return (await tryGetGitRoot(requested)) ?? requested;
};

export type RagitGitIgnorePolicy = "safe" | "snapshot-history" | "dogfood";

export interface RagitGitIgnorePolicyChoice {
  trackManifests: boolean;
  trackHarnessArtifacts: boolean;
}

export interface RagitGitIgnorePlan {
  policy: RagitGitIgnorePolicy;
  entries: string[];
}

const LOCAL_RUNTIME_ENTRIES = [
  ".ragit/store/",
  ".ragit/store.next/",
  ".ragit/store.prev/",
  ".ragit/cache/",
  ".ragit/log/",
  ".ragit/reports/",
  ".ragit/security/",
  ".ragit/memory/sessions/",
  ".ragit/memory/working/",
  ".ragit/artifacts/session/",
];

export const DEFAULT_RAGIT_GITIGNORE_CHOICE: RagitGitIgnorePolicyChoice = {
  trackManifests: false,
  trackHarnessArtifacts: false,
};

export const classifyRagitGitIgnorePolicy = (choice: RagitGitIgnorePolicyChoice): RagitGitIgnorePolicy => {
  if (choice.trackManifests && choice.trackHarnessArtifacts) return "dogfood";
  if (choice.trackManifests) return "snapshot-history";
  return "safe";
};

export const buildRagitGitIgnorePlan = (
  choice: RagitGitIgnorePolicyChoice = DEFAULT_RAGIT_GITIGNORE_CHOICE,
): RagitGitIgnorePlan => {
  const entries = [...LOCAL_RUNTIME_ENTRIES];
  if (!choice.trackManifests) entries.push(".ragit/manifest/");
  if (!choice.trackHarnessArtifacts) entries.push(".ragit/artifacts/harness/");
  return {
    policy: classifyRagitGitIgnorePolicy(choice),
    entries,
  };
};

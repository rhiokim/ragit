import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor, runStatus } from "../src/commands/bootstrap.js";
import { reviewArtifacts, searchArtifacts, sessionMaterialize } from "../src/core/artifacts.js";
import { defaultConfig, writeConfig } from "../src/core/config.js";
import { runIngest } from "../src/core/ingest.js";
import { ensureRagitStructure } from "../src/core/project.js";

const ORIGINAL_ENV = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

const ORIGINAL_FETCH = globalThis.fetch;
const tempDirs: string[] = [];

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeTempDir = async (prefix: string): Promise<string> => {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(temp);
  return temp;
};

const parseInputs = (init?: RequestInit): string[] => {
  const body = typeof init?.body === "string" ? init.body : "";
  const parsed = JSON.parse(body) as { input: string[] | string };
  return Array.isArray(parsed.input) ? parsed.input : [parsed.input];
};

const vectorForText = (text: string, dimensions: number): number[] =>
  Array.from({ length: dimensions }, (_, index) => ((text.charCodeAt(index % text.length) ?? 0) + index) / 4096);

const openAiEmbeddingResponse = (inputs: string[]): Response =>
  new Response(
    JSON.stringify({
      data: inputs.map((text, index) => ({
        index,
        embedding: vectorForText(text, 1536),
      })),
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );

afterEach(async () => {
  vi.restoreAllMocks();
  if (ORIGINAL_FETCH === undefined) {
    // @ts-expect-error node fetch may be undefined in some runtimes
    delete globalThis.fetch;
  } else {
    globalThis.fetch = ORIGINAL_FETCH;
  }
  if (ORIGINAL_ENV.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_ENV.OPENAI_API_KEY;
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((target) => rm(target, { recursive: true, force: true })));
});

describe("embedding execution integration", () => {
  it(
    "reuses the cache across ingest and artifact search while exposing cache health",
    async () => {
      process.env.OPENAI_API_KEY = "test-key";
      let calls = 0;
      globalThis.fetch = vi.fn(async (_input, init) => {
        calls += 1;
        return openAiEmbeddingResponse(parseInputs(init));
      }) as typeof fetch;

      const temp = await makeTempDir("ragit-embedding-execution-");
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await mkdir(path.join(temp, "docs"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "auth.spec.md"),
        `---
type: spec
---
# Auth Contract
Keep refresh token mutation outside snapshot writes.
`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "seed docs"]);

      await ensureRagitStructure(temp);
      const config = defaultConfig();
      config.embedding.provider = "openai";
      delete config.embedding.dimensions;
      delete config.embedding.version;
      await writeConfig(temp, config);

      await runIngest(temp, { all: true });
      expect(calls).toBe(1);

      const materialized = await sessionMaterialize(temp, {
        goal: "resume auth continuity",
        episode: { id: "ep-auth-refresh", title: "Auth refresh stabilization" },
        turns: [
          {
            turnId: "t1",
            role: "user",
            content: "Please keep the output concise and avoid replaying the whole log.",
            createdAt: "2026-04-10T10:00:00.000Z",
          },
          {
            turnId: "t2",
            role: "assistant",
            content: "Next step? unresolved blocker on token expiry flow.",
            createdAt: "2026-04-10T10:00:05.000Z",
          },
        ],
        relatedPaths: ["docs/auth.spec.md"],
        createdAt: "2026-04-10T10:00:10.000Z",
      });
      await reviewArtifacts(temp, {
        updates: materialized.artifactIds.map((artifactId) => ({
          artifactId,
          nextStatus: "reviewed",
          reason: "confirmed during integration test",
          supersedes: [],
        })),
      });

      await runIngest(temp, { all: true, scope: "all" });
      const callsAfterArtifactIndex = calls;
      expect(callsAfterArtifactIndex).toBe(1);

      await runIngest(temp, { all: true, scope: "all" });
      expect(calls).toBe(callsAfterArtifactIndex);

      const artifactSearchBefore = calls;
      const artifactSearch = await searchArtifacts(temp, "keep the output concise", "session", 3);
      const artifactHit = artifactSearch.hits[0];
      expect(artifactHit?.artifactId).toBeTruthy();
      expect(artifactHit?.citation.sourceType).toBe("artifact");
      expect(artifactHit?.scoreBreakdown.mode).toBe("keyword");
      expect(artifactHit?.scoreBreakdown.retrieval.inputs.vector.weight).toBe(0);
      expect(artifactHit?.scoreBreakdown.retrieval.inputs.keyword.weight).toBe(1);
      expect(artifactHit?.scoreBreakdown.retrieval.score).toBe(artifactHit?.scoreKeyword);
      expect(calls).toBe(artifactSearchBefore + 1);

      await searchArtifacts(temp, "keep the output concise", "session", 3);
      expect(calls).toBe(artifactSearchBefore + 1);

      const status = await runStatus(temp);
      expect(status.embedding.cache.enabled).toBe(true);
      expect(status.embedding.cache.namespaceId).toBeTruthy();
      expect(status.embedding.cache.entryCount).toBeGreaterThan(0);

      const doctor = await runDoctor(temp);
      expect(doctor.checks.find((check) => check.name === "embedding.cache-dir")?.ok).toBe(true);
      expect(doctor.checks.find((check) => check.name === "embedding.cache-namespace")?.ok).toBe(true);
    },
    20_000,
  );
});

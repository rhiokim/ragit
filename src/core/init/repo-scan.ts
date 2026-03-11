import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { listAllDocumentFiles } from "../files.js";
import { ScanSummary } from "./types.js";

const SCAN_IGNORE = ["**/.git/**", "**/.ragit/**", "**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.next/**"];
const CODE_GLOBS = ["**/*.{ts,tsx,js,jsx,mjs,cjs,cts,mts,py,rs,go,java,kt,swift,rb,php,c,cc,cpp,h,hpp}"];
const CI_GLOBS = [".github/workflows/*.yml", ".github/workflows/*.yaml"];
const INFRA_GLOBS = [
  "Dockerfile",
  "Dockerfile.*",
  "docker-compose*.yml",
  "docker-compose*.yaml",
  "k8s/**/*.yml",
  "k8s/**/*.yaml",
  "infra/**/*.tf",
  "terraform/**/*.tf",
];
const BUILD_CANDIDATES = [
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "tsconfig.json",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
];

const toRelative = (cwd: string, value: string): string => path.relative(cwd, value).replaceAll(path.sep, "/");

const listChildDirs = async (cwd: string, relativeDir: string): Promise<string[]> => {
  try {
    const entries = await readdir(path.join(cwd, relativeDir), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${relativeDir}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
};

const detectPackageManager = async (cwd: string): Promise<ScanSummary["packageManager"]> => {
  const packageJsonPath = path.join(cwd, "package.json");
  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { packageManager?: string };
    if (packageJson.packageManager?.startsWith("pnpm@")) return "pnpm";
    if (packageJson.packageManager?.startsWith("npm@")) return "npm";
    if (packageJson.packageManager?.startsWith("yarn@")) return "yarn";
    if (packageJson.packageManager?.startsWith("bun@")) return "bun";
  } catch {
    // ignore
  }

  const locks = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ] as const;

  for (const [fileName, manager] of locks) {
    try {
      await readFile(path.join(cwd, fileName), "utf8");
      return manager;
    } catch {
      // keep looking
    }
  }
  return null;
};

const detectFrameworks = async (cwd: string): Promise<string[]> => {
  const packageJsonPath = path.join(cwd, "package.json");
  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ]);
    const frameworks = [
      ["next", "Next.js"],
      ["react", "React"],
      ["expo", "Expo"],
      ["turbo", "Turborepo"],
      ["nx", "Nx"],
      ["vitest", "Vitest"],
      ["typescript", "TypeScript"],
    ] as const;
    return frameworks.filter(([dep]) => deps.has(dep)).map(([, label]) => label);
  } catch {
    return [];
  }
};

const detectLanguages = (files: string[]): string[] => {
  const languages = new Set<string>();
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if ([".ts", ".tsx", ".cts", ".mts"].includes(extension)) languages.add("TypeScript");
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) languages.add("JavaScript");
    if (extension === ".py") languages.add("Python");
    if (extension === ".rs") languages.add("Rust");
    if (extension === ".go") languages.add("Go");
    if ([".java", ".kt"].includes(extension)) languages.add("JVM");
    if ([".swift", ".m", ".mm"].includes(extension)) languages.add("Swift");
    if ([".c", ".cc", ".cpp", ".h", ".hpp"].includes(extension)) languages.add("C/C++");
  }
  return [...languages].sort();
};

export const scanRepository = async (cwd: string): Promise<ScanSummary> => {
  const [documentFiles, codeFiles, ciFiles, infraFiles, apps, packages, packageManager, frameworks] = await Promise.all([
    listAllDocumentFiles(cwd),
    fg(CODE_GLOBS, { cwd, ignore: SCAN_IGNORE, onlyFiles: true, dot: false }),
    fg(CI_GLOBS, { cwd, ignore: SCAN_IGNORE, onlyFiles: true, dot: true }),
    fg(INFRA_GLOBS, { cwd, ignore: SCAN_IGNORE, onlyFiles: true, dot: true }),
    listChildDirs(cwd, "apps"),
    listChildDirs(cwd, "packages"),
    detectPackageManager(cwd),
    detectFrameworks(cwd),
  ]);

  const buildFiles = await Promise.all(
    BUILD_CANDIDATES.map(async (candidate) => {
      try {
        await readFile(path.join(cwd, candidate), "utf8");
        return candidate;
      } catch {
        return null;
      }
    }),
  ).then((items) => items.filter((item): item is string => Boolean(item)));

  const actualWorkspaceFiles = buildFiles.filter((candidate) =>
    ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"].includes(candidate),
  );

  return {
    gitDetected: true,
    packageManager,
    languages: detectLanguages(codeFiles),
    frameworks,
    monorepo: actualWorkspaceFiles.length > 0 || apps.length > 0 || packages.length > 0,
    workspaceFiles: actualWorkspaceFiles,
    apps,
    packages,
    codeFileCount: codeFiles.length,
    docFileCount: documentFiles.length,
    existingDocs: documentFiles.map((file) => toRelative(cwd, file)).sort().slice(0, 20),
    ciFiles: ciFiles.sort(),
    infraFiles: infraFiles.sort(),
    buildFiles: buildFiles.sort(),
  };
};

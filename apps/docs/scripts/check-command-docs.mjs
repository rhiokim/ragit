import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const docsRoot = path.join(cwd, "content", "docs");
const repoRoot = path.resolve(cwd, "..", "..");
const registryPath = path.join(repoRoot, "src", "core", "commandRegistry.ts");

const loadRegistry = async () => {
  const moduleUrl = pathToFileURL(registryPath).href;
  const registry = await import(moduleUrl);
  if (typeof registry.listCommandSpecs !== "function") {
    throw new Error("command registry에서 listCommandSpecs를 찾지 못했습니다.");
  }
  return registry.listCommandSpecs();
};

const exists = (target) => fs.existsSync(target);

const readText = (target) => fs.readFileSync(target, "utf8");

const parseFrontmatter = (raw) => {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    fields[key] = value;
  }
  return fields;
};

const fail = (message, failures) => {
  failures.push(message);
  console.error(`[command-docs][fail] ${message}`);
};

const main = async () => {
  const specs = await loadRegistry();
  const failures = [];
  const locales = ["en", "ko"];
  const families = [...new Set(specs
    .map((spec) => {
      const parent = path.posix.dirname(spec.docSlug);
      return parent === "commands" ? null : parent.replace(/^commands\//, "");
    })
    .filter(Boolean))].sort();

  if (specs.length === 0) {
    throw new Error("command registry가 비어 있습니다.");
  }

  for (const locale of locales) {
    const localeRoot = path.join(docsRoot, locale);
    const commandsRoot = path.join(localeRoot, "commands");
    const rootIndex = path.join(commandsRoot, "index.mdx");
    const rootMeta = path.join(commandsRoot, "meta.json");

    if (!exists(rootIndex)) fail(`${locale}/commands/index.mdx 가 없습니다.`, failures);
    if (!exists(rootMeta)) fail(`${locale}/commands/meta.json 이 없습니다.`, failures);

    for (const family of families) {
      const familyRoot = path.join(commandsRoot, family);
      const familyIndex = path.join(familyRoot, "index.mdx");
      const familyMeta = path.join(familyRoot, "meta.json");
      if (!exists(familyIndex)) fail(`${locale}/commands/${family}/index.mdx 가 없습니다.`, failures);
      if (!exists(familyMeta)) fail(`${locale}/commands/${family}/meta.json 이 없습니다.`, failures);
    }

    for (const spec of specs) {
      const relativeDoc = `${spec.docSlug}.mdx`;
      const absoluteDoc = path.join(localeRoot, relativeDoc);
      if (!exists(absoluteDoc)) {
        fail(`${locale}/${relativeDoc} 문서가 없습니다. (${spec.path})`, failures);
        continue;
      }

      const frontmatter = parseFrontmatter(readText(absoluteDoc));
      if (frontmatter.command_path !== spec.path) {
        fail(
          `${locale}/${relativeDoc} 의 command_path가 registry와 다릅니다. expected="${spec.path}" actual="${frontmatter.command_path ?? ""}"`,
          failures,
        );
      }
      if (!frontmatter.title) {
        fail(`${locale}/${relativeDoc} 에 title frontmatter가 없습니다.`, failures);
      }
      if (!frontmatter.description) {
        fail(`${locale}/${relativeDoc} 에 description frontmatter가 없습니다.`, failures);
      }
    }

    const actualLeafDocs = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (!entry.name.endsWith(".mdx")) continue;
        const frontmatter = parseFrontmatter(readText(absolute));
        if (frontmatter.command_path) {
          actualLeafDocs.push(path.relative(localeRoot, absolute).replaceAll(path.sep, "/"));
        }
      }
    };
    if (exists(commandsRoot)) {
      walk(commandsRoot);
    }
    if (actualLeafDocs.length !== specs.length) {
      fail(
        `${locale}/commands leaf 문서 수가 registry와 다릅니다. expected=${specs.length} actual=${actualLeafDocs.length}`,
        failures,
      );
    }
  }

  if (failures.length > 0) {
    console.error(`[command-docs] failures=${failures.length}`);
    process.exit(1);
  }

  console.log(`[command-docs] verified ${specs.length} leaf commands across en/ko locales.`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[command-docs][error] ${message}`);
  process.exit(1);
});

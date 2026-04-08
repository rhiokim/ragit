---
status: draft
source: inferred-from-repository
confidence: medium
last_generated_by: ragit init
---

# RAGIT

## Repository Snapshot

- Repository mode: `monorepo`
- Strategy: `balanced`
- Package manager: `pnpm`
- Languages: JavaScript, TypeScript
- Frameworks: Vitest, TypeScript
- Monorepo: yes
- Code files: 133
- Docs: 139

## Knowledge Source Priority

- `project`: `README.md`
- `product`: `README.md`, `testbed/docs/prd/prd-self-referential-testbed.md`
- `architecture`: `apps/docs/content/docs/en/(overview)/architecture.mdx`, `apps/docs/content/docs/ko/(overview)/architecture.mdx`, `apps/docs/out/llms.mdx/en/docs/architecture/index.mdx`, `apps/docs/out/llms.mdx/ko/docs/architecture/index.mdx`, `testbed/docs/ddd/ddd-core-models.md`, `testbed/docs/spec/spec-round-1-execution.md`, `testbed/docs/srs/srs-round-1-testbed.md`
- `workspace`: `apps/docs/README.md`, `pnpm-workspace.yaml`
- `decisions`: `testbed/docs/adr/adr-local-pnpm-runner.md`
- `operations`: `.github/workflows/docs-gh-pages.yml`, `.github/workflows/publish.yml`
- `glossary`: `testbed/docs/ddd/ddd-core-models.md`, `testbed/docs/glossary/glossary-testbed.md`
- `ingestion-policy`: `.ragit/config.toml`

## Coverage Snapshot

- Project overview: sufficient
- Local development guide: partial
- Architecture rationale: sufficient
- Decision records: sufficient
- Package ownership map: sufficient
- Ingestion policy: partial

## Operating Notes

- Prefer existing repository documents over generated drafts.
- Treat generated documents as inferred notes until humans validate them.
- Re-run `ragit init --merge-existing` when foundational docs drift.

---
type: plan
---
# GitHub Actions Node 20 Deprecation Remediation

## Summary

The repo has two separate warning surfaces:

1. repo-controlled workflows that still pin `actions/*@v4` and `pnpm/action-setup@v4`
2. GitHub Pages legacy follow-up runs that GitHub generates after the repository pushes to `gh-pages`

The minimal fix is to upgrade the repo-controlled workflows to the Node 24-runtime action majors already available from the action authors. That removes the deprecation warnings the repository directly controls.

If the goal is to eliminate the Pages warning path as well, the deployment model must move away from `gh-pages` branch push deployment and onto the GitHub Pages Actions artifact flow. That is a separate migration, not a simple version bump.

## Current Repo Reality

- `.github/workflows/docs-gh-pages.yml` currently uses:
  - `actions/checkout@v4`
  - `pnpm/action-setup@v4`
  - `actions/setup-node@v4`
  - project `node-version: 24`
  - branch push deployment to `gh-pages`
- `.github/workflows/publish.yml` currently uses:
  - `actions/checkout@v4`
  - `pnpm/action-setup@v4`
  - `actions/setup-node@v4`
  - project `node-version: 22`
  - npm publish on tags
- GitHub Pages is currently configured as `build_type: legacy` with `gh-pages` as the source branch.
- The latest repo-visible Pages follow-up run warnings are coming from GitHub-generated legacy Pages deployment infrastructure, not from a workflow file in this repository.

## Decision

Use a two-stage plan.

### Stage 1: Immediate minimum fix

Upgrade the repo-controlled workflows to Node 24-runtime action majors:

- `actions/checkout@v5`
- `pnpm/action-setup@v5`
- `actions/setup-node@v5`

Keep the project Node versions as they are unless a separate runtime upgrade is desired later:

- `docs-gh-pages.yml` stays on `node-version: 24`
- `publish.yml` stays on `node-version: 22`

Keep `setup-node` cache behavior explicit:

- continue to set `cache: "pnpm"`
- add or keep `cache-dependency-path: pnpm-lock.yaml` so cache keys are deterministic
- do not rely on auto cache detection in `setup-node@v5`

This stage should remove the Node 20 deprecation warnings that come from the repository’s own workflow steps.

### Stage 2: Complete warning removal

If the requirement is to remove the GitHub Pages legacy follow-up warning as well, migrate the docs deployment from `gh-pages` branch push to GitHub Pages Actions deployment:

- switch the repository Pages source from `gh-pages` branch to GitHub Actions
- replace the branch-push deploy step with:
  - `actions/configure-pages@v5`
  - `actions/upload-pages-artifact@v4`
  - `actions/deploy-pages@v4`
- set the required Pages permissions:
  - `pages: write`
  - `id-token: write`
- use the `github-pages` environment in the deploy job

This is the only path that can remove the legacy `pages-build-deployment` warning surface from the repository’s deployment model.

## Key Changes

### Minimal fix

- Update `.github/workflows/docs-gh-pages.yml` to action majors that run on Node 24.
- Update `.github/workflows/publish.yml` to action majors that run on Node 24.
- Make `setup-node` cache intent explicit for pnpm.
- Leave the current `gh-pages` branch deploy model intact.

### Full removal path

- Replace the docs workflow’s branch push deployment with a Pages Actions artifact workflow.
- Adjust repository Pages settings away from legacy branch source.
- Keep the docs build step in the repo-controlled workflow, but move the deploy boundary to Pages artifact upload/deploy.

## Likely Files To Touch

- `.github/workflows/docs-gh-pages.yml`
- `.github/workflows/publish.yml`
- optionally add a new Pages workflow file if the team chooses to keep the legacy docs workflow around during migration
- repository Pages settings in GitHub, if the complete-removal path is chosen

## Test Plan

- Run the docs workflow locally through normal repo validation:
  - `pnpm docs:check:i18n`
  - `pnpm docs:check:commands`
  - `pnpm docs:check:search-index`
  - `pnpm docs:build`
- Run the release workflow checks locally:
  - `pnpm test`
  - `pnpm build`
  - `pnpm build:verify`
  - `pnpm pack:verify`
  - `pnpm pack:smoke`
- After merging the workflow updates:
  - inspect a new `docs-gh-pages` run to confirm the Node 20 warnings from repo-controlled actions are gone
  - inspect a new `publish` run to confirm the upgraded action majors behave normally on the current runner
- If the full-removal path is chosen:
  - confirm the repository Pages source is no longer `legacy`
  - confirm the new Pages deploy job produces a successful deployment without legacy follow-up warnings

## Assumptions

- The repository is using GitHub-hosted runners, so the Node 24-runtime action majors are expected to be supported without a self-hosted runner upgrade.
- The latest action majors listed in the prompt are trusted as the current target set for the minimum fix.
- The project does not need a Node runtime bump just to upgrade the GitHub Actions majors; the workflow action runtime and the installed project Node version are separate concerns.
- `publish.yml` does not need Pages artifact deployment unless the team wants to unify deployment models later.

## Risks / Open Questions

- The legacy Pages warning cannot be removed by editing this repository alone while the Pages source remains `gh-pages`.
- `setup-node@v5` changed cache semantics enough that a version bump without an explicit cache strategy would be fragile.
- `actions/checkout@v5`, `actions/setup-node@v5`, and `pnpm/action-setup@v5` require sufficiently recent runners; this is usually fine on GitHub-hosted runners, but self-hosted runners would need a version check.
- The full-removal path changes the deployment topology, so it should be treated as a separate migration with its own validation, not as a trivial patch.

## Suggested Commit Split

1. `ci: upgrade workflow actions to node24 majors`
   - bump repo-controlled actions
   - make pnpm cache intent explicit
2. `ci: migrate docs deployment to github pages actions`
   - replace gh-pages branch push with Pages artifact deployment
   - update repository Pages source
3. `docs: explain pages deployment model`
   - document the workflow choice in repo docs if needed

## Recommendation

Apply Stage 1 immediately to remove the warnings the repository directly controls. If the requirement is strict zero-warning closure, plan Stage 2 as a separate migration and treat it as a Pages deployment redesign rather than a dependency bump.

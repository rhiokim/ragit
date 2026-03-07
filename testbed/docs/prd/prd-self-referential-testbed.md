---
type: prd
---
# PRD: Self-referential RAGit test bed

## Goal

The product goal of this round is to use the RAGit repository as a self-referential test bed.
The test bed should prove that RAGit can initialize itself, ingest project knowledge, answer questions, and reconstruct commit-bound context.

## Product Purpose

The product purpose of RAGit in this test bed is to turn repository-local AI agent documents and context into commit-bound, reusable knowledge.

## User Value

Users should understand that Git and RAGit solve adjacent but different problems.
Git version-controls source code states.
RAGit version-controls AI-working knowledge states bound to the same commit history.

Users should be able to explain the product purpose and core value of RAGit from repository-local knowledge.
Users should understand that local repository usage runs through `pnpm ragit`, while `pnpm build` is optional for repository-local execution.
Users should understand the difference between Git code history and RAGit commit-bound knowledge history.

## Success Criteria

The isolated test corpus should return correct answers for golden queries.
Time-travel queries with `--at <sha>` should reflect old and new document states.
Mixed ingest with repository-wide documents should still keep core test-bed questions inside the top three hits.

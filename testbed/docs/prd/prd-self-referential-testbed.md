---
type: prd
---
# PRD: Self-referential RAGit test bed

## Goal

The product goal of this round is to use the RAGit repository as a self-referential test bed.
The test bed should prove that RAGit can initialize itself, ingest project knowledge, answer questions, and reconstruct commit-bound context.

## User Value

Users should understand that Git and RAGit solve adjacent but different problems.
Git version-controls source code states.
RAGit version-controls AI-working knowledge states bound to the same commit history.

Users should also be able to answer the following product questions:

- What is the product purpose of RAGit?
- What are the core values of RAGit?
- How do I run RAGit locally without building dist?
- What changed after build became optional?

## Success Criteria

The isolated test corpus should return correct answers for golden queries.
Time-travel queries with `--at <sha>` should reflect old and new document states.
Mixed ingest with repository-wide documents should still keep core test-bed questions inside the top three hits.

---
type: ddd
---
# DDD: Core models for the round-1 test bed

## Bounded Context

The bounded context is commit-bound retrieval for repository-local AI working knowledge.

## Aggregate

### Commit

A Commit is the source-of-truth boundary shared by Git and RAGit.
Git stores the code state of the commit.
RAGit stores the knowledge snapshot bound to the same commit SHA.

### Snapshot

A Snapshot is the retrieval state recorded in `.ragit/manifest/<commit-sha>.json`.
It references the set of documents and chunks that define searchable knowledge for a commit.

### Document

A Document is a typed markdown artifact such as ADR, PRD, SRS, SPEC, Plan, DDD, Glossary, or PBD.
In the test bed, each document belongs to the `testbed/docs/` corpus.

### Chunk

A Chunk is a searchable section fragment derived from a document.
Query ranking combines vector similarity and keyword score over chunks.

### Query

A Query asks for knowledge at HEAD or at a specific snapshot SHA.
The result is meaningful only if the bound snapshot reflects the intended commit state.

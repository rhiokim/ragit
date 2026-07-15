# Production Embedding Profiles — Design

**Status:** Approved
**Design/review owner:** Sol Max
**Bounded implementation worker:** Terra
**Baseline:** `origin/main` at `89e25dd`, package `ragit@1.1.2`
**Date:** 2026-07-15

## Outcome

Turn the existing OpenAI and Ollama embedding facade into an evidence-backed production boundary. A supported provider response must map every input to exactly one valid vector, fail closed on ambiguous data, preserve cache and migration identity, and produce a provider-labeled retrieval report without changing the deterministic B1 benchmark.

## Assumptions and Decisions

- The recognized profiles remain exactly the four already present in RAGit:
  - OpenAI `text-embedding-3-small` at 1536 dimensions;
  - OpenAI `text-embedding-3-large` at 3072 dimensions;
  - Ollama `nomic-embed-text` at 768 dimensions;
  - Ollama `mxbai-embed-large` at 1024 dimensions.
- Recognition is not the same as an evidence-backed production declaration. This workstream must collect live evidence for at least one OpenAI profile and one loopback Ollama profile.
- `local-placeholder` remains the default for offline deterministic development. It is never described as production-quality evidence.
- Model aliases, arbitrary dimensions, new providers, retrieval-weight changes, dataset changes, and package-version changes are out of scope.
- OpenAI credentials remain environment-only. A live run stops when `OPENAI_API_KEY` is unavailable; no secret is accepted through a CLI argument, config value, fixture, report, or committed artifact.
- The existing B1 dataset and default report stay structurally stable. Provider evidence is opt-in and additive.

## Provider Response Integrity

### Shared vector contract

For a request containing `N` texts, a successful response must contain exactly `N` vectors. Every vector must:

- be an array;
- contain exactly the profile's configured dimensions;
- contain only JavaScript numbers;
- contain only finite values.

Malformed shape, wrong cardinality, duplicate/missing indexes, and non-finite values produce a non-retryable `RESPONSE_INVALID` provider error. A dimension mismatch keeps the existing non-retryable `DIMENSION_MISMATCH` error.

RAGit must not insert a zero vector when a provider result or internal result slot is missing. The zero vector remains valid only as the intentional result of the deterministic placeholder for empty token input.

Cache reads apply the same finite-vector validation. An invalid cache entry is treated as a miss, never as a valid embedding.

### OpenAI ordering

The OpenAI embeddings response identifies each vector with `data[].index`. RAGit validates that indexes are unique integers covering `0..N-1`, then reorders vectors by index before returning them. Array arrival order is not treated as input order.

### Ollama ordering

Ollama `/api/embed` returns `embeddings` as an array corresponding to the input array. RAGit preserves that order and enforces exact cardinality.

## Endpoint and Credential Contract

- OpenAI uses `OPENAI_API_KEY`; the key never appears in normalized errors or reports.
- `embedding.base_url`, `OPENAI_BASE_URL`, and `OLLAMA_BASE_URL` denote a provider root, not the final embeddings endpoint.
- A non-placeholder provider root must be an absolute `http:` or `https:` URL without username, password, query, or fragment. Trailing slashes are removed.
- OpenAI appends `/v1/embeddings`; Ollama appends `/api/embed`.
- Custom roots are supported for compatible gateways, but reports expose only an endpoint class, never the URL.
- Endpoint classes are `openai-public`, `ollama-local`, and `custom`.

## Timeout and Retry Contract

- A timeout aborts the active fetch and surfaces a retryable `TIMEOUT` error.
- HTTP 429 and 5xx responses are retryable. Other 4xx responses are not.
- `Retry-After`, when valid, is a minimum delay. Jitter may lengthen that value but must never shorten it.
- Response validation failures are not retried. Retrying a structurally successful but unusable response would hide a provider contract violation and multiply cost.
- Existing provider batch sizes and retry-attempt counts remain unchanged.

## Evidence Runner

The existing `scripts/benchmark-retrieval.ts` gains opt-in arguments:

```text
--embedding-profile <provider/model>
--embedding-base-url <provider-root>
--embedding-timeout-ms <positive-integer>
```

Accepted profile IDs are only:

```text
openai/text-embedding-3-small
openai/text-embedding-3-large
ollama/nomic-embed-text
ollama/mxbai-embed-large
```

When no embedding arguments are present, the B1 local-placeholder path and its serialized report shape remain unchanged. When a profile is explicit, the materialized fixture repository is configured before its initialization commit and the report adds only `profile.endpointClass`.

The runner never accepts an API key argument and never serializes a base URL. Its normal report already contains dataset identity, model identity, dimensions, version, quality metrics, noise behavior, per-case rankings, and latency.

## Pre-committed Gates

Provider thresholds are fixed before live runs so evidence cannot be tuned after observing results.

Both production candidates reuse the B1 quality and noise floors:

- Recall@5 >= `0.654166`;
- MRR@10 >= `0.515446`;
- nDCG@10 >= `0.569941`;
- relative noise drop <= `0.05`.

Latency ceilings are endpoint-class service gates rather than comparisons with the in-process placeholder:

- `openai-public`: p95 <= `2000 ms`;
- `ollama-local`: p95 <= `1000 ms`.

The initial evidence targets are OpenAI `text-embedding-3-small` and Ollama `nomic-embed-text`. A failed target is not declared production-supported. Switching to another recognized profile requires a new threshold file before its live run. Adding a new model requires a separate design decision.

## Evidence Handling

- Deterministic mocked contracts run in normal CI.
- Live runs are opt-in and write reports only to an explicitly supplied output path.
- Full reports are retained as PR or CI artifacts; the repository records the command, report digest, environment class, and gate result without committing credentials or endpoint URLs.
- Sol Max independently runs and interprets live evidence. Terra does not change thresholds or support claims.

## Compatibility

- Cache namespace identity remains schema/provider/model/version/dimensions/base URL.
- Store migration behavior and manifest preservation remain unchanged.
- Existing config keys and recognized models remain valid.
- Retrieval scoring, candidate count, B1 dataset, B1 thresholds, Context Pack behavior, package version, MCP, zvec, and distribution workflows are prohibited scope.

## Success Criteria

1. Focused tests prove exact response cardinality, OpenAI index reordering, Ollama order, finite numbers, dimension checks, no zero fallback, timeout abort, retry classification, `Retry-After`, credentials, base URL validation, and cache isolation.
2. The default B1 report retains identical quality groups, per-case metrics, and all 108 ranked-path arrays.
3. Provider reports identify the exact profile and endpoint class without containing a credential or base URL.
4. Live Ollama and OpenAI reports pass their pre-committed gates before either is called evidence-backed.
5. Full test, build, pack, bilingual docs, and clean-worktree gates pass.

## Research Basis

- OpenAI defines `data[].index` as the embedding's index in the returned list and documents 1536/3072 default dimensions for the two v3 models: <https://developers.openai.com/api/reference/resources/embeddings/methods/create>
- OpenAI documents `text-embedding-3-small` and `text-embedding-3-large` as its current third-generation embedding models: <https://developers.openai.com/api/docs/guides/embeddings>
- Ollama `/api/embed` accepts one string or an array and returns `embeddings: number[][]`: <https://docs.ollama.com/api/embed>
- Ollama documents batched inputs and matching vector counts, with L2-normalized output: <https://docs.ollama.com/capabilities/embeddings>
- Ollama's registry currently exposes the selected `nomic-embed-text` model and 768-dimensional metadata: <https://ollama.com/library/nomic-embed-text>

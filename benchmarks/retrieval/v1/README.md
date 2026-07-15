# Retrieval v1 Provider Evidence

This directory contains the fixed corpus and thresholds for RAGit's retrieval evidence workflow. Recognition, evidence, and offline development coverage are separate states.

## Profile Status

RAGit recognizes exactly these profiles:

| Provider | Model | Dimensions |
| --- | --- | --- |
| `openai` | `text-embedding-3-small` | 1536 |
| `openai` | `text-embedding-3-large` | 3072 |
| `ollama` | `nomic-embed-text` | 768 |
| `ollama` | `mxbai-embed-large` | 1024 |

The deterministic offline profile is `local-placeholder/placeholder-v1` (64 dimensions). Its reports set `developmentOnly: true`; it is development/regression coverage only and never production retrieval-quality evidence.

An evidence-backed profile is a recognized profile with a reproducible live report that passes its precommitted profile threshold. The initial targets are pending: neither OpenAI `text-embedding-3-small` nor Ollama `nomic-embed-text` has been run as live evidence in this workstream, so neither is evidence-backed or production-supported.

| Initial target | Evidence status | Threshold file |
| --- | --- | --- |
| `openai/text-embedding-3-small` | Pending live evidence | `thresholds-openai-text-embedding-3-small.json` |
| `ollama/nomic-embed-text` | Pending live evidence | `thresholds-ollama-nomic-embed-text.json` |

## Run The Benchmarks

Write reports to explicit untracked paths outside the repository. Do not commit raw live reports or credentials.

Offline deterministic regression:

```bash
pnpm benchmark:retrieval:verify --output /tmp/ragit-retrieval-local.json
```

Loopback Ollama evidence requires a loopback server and the exact `nomic-embed-text` model to already be available:

```bash
pnpm benchmark:retrieval:ollama:verify --output /tmp/ragit-retrieval-ollama.json
```

OpenAI evidence requires `OPENAI_API_KEY` to be supplied locally in the command environment and paid-use authorization. The command never accepts or prints the key:

```bash
pnpm benchmark:retrieval:openai:verify --output /tmp/ragit-retrieval-openai.json
```

The default OpenAI provider root is `https://api.openai.com`; a configured custom root is classified without serializing its URL. Endpoint classes are `openai-public` for that exact public root, `ollama-local` for Ollama on `localhost`, `127.0.0.1`, or `::1`, and `custom` otherwise.

## Fixed Gates

Both initial targets use these precommitted quality gates:

| Metric | Required value |
| --- | --- |
| Recall@5 | `>= 0.654166` |
| MRR@10 | `>= 0.515446` |
| nDCG@10 | `>= 0.569941` |
| Relative noise drop | `<= 0.05` |

The OpenAI target additionally requires p95 latency `<= 2000ms`; the loopback Ollama target requires p95 latency `<= 1000ms`. Never tune a threshold after seeing a live result. A failed or unavailable target remains recognized but is not evidence-backed or production-supported.

## Report And Evidence Record

An explicit provider report identifies its schema, profile, provider, model, version, dimensions, endpoint class, dataset ID, aggregate/slice/case metrics, rankings, paired-noise behavior, and latency. It never includes a base URL or credentials.

After a live run, retain the raw report only as an external/CI artifact. A repository evidence record may retain only non-sensitive environment class, version/model digest where applicable, report SHA-256, metrics, latency, and gate result. Do not retain endpoint URLs, credentials, local usernames, absolute paths, or raw reports in the repository.

# Disclosure evidence — Ox Alpha → GLM 5.3 Flash (HOK-2866)

OpenRouter has disclosed that the provisional stealth model `ox-alpha`
(`stealth/ox-alpha`) is **GLM 5.3 Flash** by Z.ai.

- Disclosure page: <https://openrouter.ai/z-ai/glm-5.3-flash>
- Authoritative machine source: `GET https://openrouter.ai/api/v1/models`
- Final wire ID: `z-ai/glm-5.3-flash` (canonical slug `z-ai/glm-5.3-flash-20260826`)
- Display name: `Z.ai: GLM 5.3 Flash`
- Vendor/family: Z.ai / glm
- Context length: **1,310,720** tokens (top provider serves 1,048,576)
- Modality: `text+image+video->text`; `tools` / `tool_choice` / `reasoning` supported
- Reasoning: mandatory, default-enabled, efforts `max|high|low` (default `max`)

## Live catalog captures

Two independent captures of the full `GET /api/v1/models` response body were
taken during the coding phase. The raw bodies (683,163 bytes, 415 models each)
are hashed rather than committed; the extracted `z-ai/glm-5.3-flash` entries
are stored verbatim in the observation files next to this document.

| Capture | Observed at (UTC) | Raw body sha256 | `z-ai/glm-5.3-flash` | `stealth/ox-alpha` |
|---------|-------------------|-----------------|----------------------|--------------------|
| 1 | 2026-08-27T22:55:48.000Z | `43d7c16065ef1016deaea32990c9653a393b9aaba00a14a7674c9784215363ec` | present | absent |
| 2 | 2026-08-27T22:55:51.000Z | `43d7c16065ef1016deaea32990c9653a393b9aaba00a14a7674c9784215363ec` | present | absent |

The two captures are byte-identical (same sha256) and the extracted entries are
deep-equal. `stealth/ox-alpha` is absent from both captures: the stealth
identity is retired upstream.

Capture 1 is the promotion's source of truth: its `observedAt` and raw-body
sha256 are recorded as `final.verification.observedAt` / `catalogHash` in
`transitions/ox-alpha-to-glm-5.3-flash.json`.

## Advertised pricing (capture 1)

OpenRouter advertises per-token USD prices; the transition spec records
per-million-token (per-MTok) values:

| Dimension | Advertised (USD/token) | Recorded (USD/MTok) |
|-----------|------------------------|---------------------|
| `prompt` | `0.000000075` | `inputCostPerMTok: 0.075` |
| `completion` | `0.00000025` | `outputCostPerMTok: 0.25` |
| `input_cache_read` | `0.000000015` | `cacheReadCostPerMTok: 0.015` |
| `input_cache_write` | *not advertised* | `cacheWriteCostPerMTok: 0` |

**Cache-write note:** OpenRouter advertises no `input_cache_write` dimension
for this model. The transition schema requires all four price numbers, so
`cacheWriteCostPerMTok: 0` is a schema-forced representation of "provider
advertises no separate cache-write price" — it is not a guess and not a claim
that cache writes are free of input-token cost.

## Benchmarks visible at disclosure (context only, not transferred)

The catalog entry carries Artificial Analysis indices (intelligence 57.5,
coding 71.5, agentic 58.2). Per the promotion constraints these third-party
numbers are **not** transferred into wavemill quality priors: the promoted
entry lands with `qualityScores` all 0 and accumulates canonical local
evidence after routing eligibility is enabled.

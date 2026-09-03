# Model manifest

The [bundled manifest](../../apps/server/src/provider/model-manifest.json) allows
offline startup; fetching it from `main` lets model metadata change between
releases. Failed fetches or invalid data preserve the last usable manifest.
Remote data must pass both catalog-reference validation and the owning provider's
adapter validation before replacing the cache.

A newer bundle outranks the cached remote manifest by `updatedAt`, so a release can
correct model data before the next successful fetch. Bump `updatedAt` whenever the
file changes. Fetch time cannot establish which copy contains the newer edit.

Claude Code reports the current session's available models during provider initialization. A
non-empty runtime inventory filters the manifest's current models and can add a model before the
manifest knows about it. Matching manifest entries still own presentation, aliases, capabilities,
legacy status, and dispatch metadata. T3 keeps version-compatible legacy entries as an explicit
escape hatch and falls back to the version-filtered manifest when runtime discovery is empty or
unavailable. Runtime-backed snapshots mark their model inventory as authoritative so provider
reconciliation does not restore models Claude omitted.

To add metadata for a Claude model that uses an existing profile, add one object to
`providers.claudeAgent.models`. Do not add a test or change application code. Add or change a
profile in the same JSON file only when the model exposes a capability combination that does not
already exist.

`currentModels.claudeAgent` is frozen for releases that predate catalog discovery.
Do not extend it when adding Claude models. Codex uses `currentModels.codex` as a
legacy-classification overlay for discovered models.

Model data is schema-validated configuration. Tests should cover resolver, cache,
and adapter semantics with synthetic model names, so adding a model never requires
tests that repeat the configuration.

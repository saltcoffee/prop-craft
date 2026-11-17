# Changelog

Notable changes to PropCraft, grouped by release.

## 0.1.3 — 2026-11-17

### Added

- A property value workbench inside the Properties tab: complete value distribution, actual storage type versus the vault-wide declared type, field and list-member views, special-state summaries, selection, search, paging, and per-value note drill-down.
- Exact, typed multi-value mapping: map several historical values to a standard value in one preview, replace list members in place with order-preserving target deduplication, and fill missing/null/empty-text/empty-list states with explicit targets, including a standalone fill entry for fully-missing properties.
- Explicit text assistants (trim, lower/upper case) that only produce visible rules for selected text values and protect link-like strings.
- Explainable type repair: text → number with representation and precision checks, single-value → list wrapping, literal/newline list splitting with optional trimming, and date normalization with interpretation and value-loss confirmations.
- Independent per-note confirmations for value representation changes and declared-type mismatches that can be confirmed or withdrawn; required checks and unsatisfied ones are tracked separately.
- Bilingual (English/Simplified Chinese) interface strings for the workbench, mapping, conversion and new issue explanations.

### Changed

- New value operations only ever change note data; the vault-wide `types.json` declaration is read, never written, and each write re-checks the declaration baseline.
- New value operations use new operation kinds (`mapPropertyValues`, `convertPropertyType`) so 0.1.2 cannot silently retry a new date/type choice; legacy `normalizeDate` records keep their original structure.
- Date analysis rejects illegal hours/minutes/seconds and unpreservable time zones or fractions before conversion, sharing one validator across old and new entry points.

### Notes

- YAML comments, quoting and layout may still be reformatted; unaffected values and body text are preserved.
- Declared types are not migrated: the Properties panel may still show the vault-wide declared type even after note data is changed.
- Recovery journals remain V2. Unknown operation kinds are read-only and unsupported; downgrading to 0.1.2 cannot restore or retry new value operations.

## 0.1.2 — 2026-11-14

### Added

- Shared note scope across property, tag and bulk actions: folders, AND tag/property conditions, note review and session-only manual exclusions.
- Per-note preview selection, conflict decisions, filtered batch strategies, explicit ambiguous-date confirmation, and typed differences with body tag context.
- Shared execution progress, cancellation, complete result lists, restricted retry previews and recovery previews with partial recovery tracking.
- Versioned write-ahead recovery journals, interruption reconciliation, capacity checks before writing, and explicit removal of individual completed records.

### Fixed

- Bind changes to preview contents and compare the complete original inside one `Vault.process` callback. Body and frontmatter changes now write together.
- Keep unresolved destructive conflicts skipped; use exact case-insensitive tag identity without folding separators.
- Preserve later edits during undo, retain legacy history safely, and make corrupt or unsupported records visible and read-only.
- Retain source property type declarations, only add missing target declarations, check target compatibility, and recover type changes by key while preserving other declarations.

### Notes

- YAML comments, quoting and layout can be reformatted. Ordinary note body text is preserved except for selected tags.
- History is no longer automatically pruned. New writes stop when the configured count or capacity limit is reached.
- New V2 recovery records require PropCraft 0.1.2 or later; legacy records without an after-content hash cannot authorize restoration.

## 0.1.1 — 2026-11-12

### Fixed

- Settings adopt Obsidian's declarative settings API (1.13+): they now render through `getSettingDefinitions()` and appear in Obsidian's settings search, with `display()` kept for older versions.
- Use `window.setTimeout` / `window.clearTimeout` for popout-window compatibility.
- Removed unnecessary non-null assertions and unsafe return/assignment casts surfaced by the plugin linter.
- Renamed the command id to `open` so it no longer includes the plugin id, and awaited `Workspace.revealLeaf`.
- Fixed a `no-useless-assignment` in the release check script.

### Changed

- Bumped the `obsidian` development type definitions to 1.14.4 for the declarative settings API.

## 0.1.0 — 2026-11-12

### Added

- A dedicated PropCraft workspace that lists every property key and tag across the vault, with counts, value types, and sample values.
- Orphan-property detection for keys used only once, plus suspected-duplicate tag and key groups based on case, singular/plural, separators, and edit distance.
- Drag-to-merge and rename for tags (both the `tags` field and inline `#tags`) and for property keys, with a conflict strategy for values.
- A per-file change preview before anything is written, and background batch writes with progress and cancellation.
- Visual bulk operations: add a property to every note in a folder, and normalize text dates to ISO `YYYY-MM-DD`.
- One-click undo of the most recent batch operation, backed by a local change journal.
- Property-type migration for renamed keys, exclusion rules, and protection for reserved keys.
- English and Simplified Chinese interface text, following the Obsidian language setting.

### Notes

- Works offline. No telemetry, no network requests, and no access outside the vault.
- Requires Obsidian 1.8.7 or later.

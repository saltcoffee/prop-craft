# Changelog

Notable changes to PropCraft, grouped by release.

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

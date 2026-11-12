# Changelog

Notable changes to PropCraft, grouped by release.

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

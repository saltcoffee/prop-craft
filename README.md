# PropCraft

A visual workbench that cleans up properties and tags within a chosen set of Obsidian notes — merge tags, rename fields, add properties in bulk, and normalize dates. No code, no regex.

[简体中文](README.zh-CN.md)

## Why PropCraft

After a few months of use, a vault fills up with near-duplicates: `#reading`, `#read`, and `#book` all describing the same thing; `author`, `Author`, and `writer` all pointing at a person; dates written five different ways. The built-in property panel only renames one field in one note at a time, and deeper cleanup usually means learning a scripting language or a linter plugin.

PropCraft turns that cleanup into sorting a spreadsheet. Open the workbench, see every property and tag in one place, and fix them with a drag.

## Features

- **Choose the notes.** Combine a vault folder, tag conditions and property conditions with AND; review matches and exclude individual notes. The scope follows you across the workbench tabs.
- **Everything in one view.** Every property key and tag in the vault, with how many notes use it, its value type, and sample values.
- **See every value.** Open a property to inspect its complete value distribution, actual storage type versus the vault-wide declaration, and list members, then drill into any value's notes.
- **Map many values at once.** Map `已读` / `finished` / `Done ` to one standard value, replace list members in place, fill missing or empty values, and repair `"5"` → `5`, wrap or split lists, and normalize dates with an explanation for every exception.
- **Spot the mess.** Orphan properties used only once, and suspected-duplicate tags or keys (case, singular/plural, separators, typos) are grouped and highlighted.
- **Drag to merge or migrate a tag tree.** Browse tags as a flat list or a hierarchy tree showing real tags, virtual parents, direct note counts, and deduplicated branch note counts. Rename a single tag or migrate an entire branch (`#domain/tech/...` → `#topic/tech/...`) with full mapping and vault-wide read-only collision previews.
- **Convert tags into properties.** Map exact source tags to a typed scalar property (`#status/done` → `status: done`) or append into a list property in rule order. Source tags are kept by default; when removal is enabled, only tags represented by the final property value are removed in the same single-note write, while unadopted or conflicting sources remain intact.
- **Rename or merge fields.** Collapse `author` / `Author` / `writer` into one property, choosing how conflicting values are combined.
- **Bulk add properties.** Give every note in a folder a field such as `status: unread`, all from a guided wizard.
- **Normalize dates.** Turn `2024/1/5`, `Jan 5, 2024`, and `2024年1月5日` into a consistent `2024-01-05`.
- **Decide per note.** Select notes and choose conflict strategies before applying. Unresolved destructive conflicts are skipped; ambiguous dates require confirmation.
- **Recover with evidence.** Every batch keeps a local journal. Review undo first; later edits are preserved and partial recovery stays visible. Retry previews include only unfinished paths.
- **Speaks your language.** Chinese when Obsidian is in Chinese, English otherwise.

## How to use

1. Open the PropCraft view from the ribbon or the command palette.
2. Choose the shared note scope in **Properties**, **Tags**, or **Bulk actions**, then review the matched notes. Browse the **Properties** and **Tags** views. Open the **Suggested cleanups** to see orphans and likely duplicates.
3. Drag one tag onto another, or use the row menu to rename or merge a property.
4. Review the preview, deselect exceptions and resolve conflicts. Check the actual note count before applying.
5. If something looks wrong, use **Undo** in the result panel or the **History** view.

## Compatibility and limitations

Requires **desktop** Obsidian **1.8.7 or later**. Mobile devices are not supported.

PropCraft only changes the metadata and tags you select. It does not rewrite note body text other than inline `#tags`, and it skips notes whose properties cannot be parsed instead of overwriting them. Property actions protect reserved fields such as `tags`, `aliases`, and `cssclasses`; tag actions update the matching frontmatter tags and body tags together. Notes excluded by settings are never written.

YAML comments, quoting and layout may change during serialization. Unknown or unsafe YAML is blocked. Tag matching ignores case but keeps `_` and `-` distinct; the scope filter's "include descendants" toggle is independent from a tag migration's "this tag only / include all descendants" mode. Frontmatter deduplicates rewritten target tags by keeping the earliest member, while body occurrences are rewritten in place without deleting existing target tags in other contexts. Removing all tags from a frontmatter `tags`/`tag` container leaves `[]`. Query, template, and script references are not automatically checked or updated.

History limits are checked before any note or type write, including UTF-8 recovery materials and state capacity. At the limit, review History and explicitly remove one eligible completed record, or adjust the limits in Settings. Unfinished and partly recovered records are protected; nothing is automatically pruned. A write with uncertain outcome must be reconciled before retrying. Type dependency checks read metadata across the vault, including excluded notes, without writing those notes.

If an initial state file is missing, History can confirm the checked state without content writes only when all notes match their recorded originals and the type addition needs no recovery. Damaged state files remain read-only.

Upgrading preserves 0.1.1–0.1.3 history. Legacy records without a trustworthy after-content hash remain read-only for changed notes, and do not contain recoverable type snapshots. Recovery of V2 transactions requires a version that recognizes the operation kind (0.1.4+ for tag branch migration and tag-to-property conversion); downgrading does not provide recovery or retry for newer operation kinds.

## Installation

1. Open **Settings → Community plugins** in Obsidian.
2. Select **Browse** and search for **PropCraft**.
3. Select **Install**, then **Enable**.

## Privacy

PropCraft works entirely offline. There are no accounts, no network requests, no telemetry, and no access to files outside your vault. Undo history is stored locally in the plugin's own folder.

## Support development

PropCraft is free. If it saves you time, voluntary donations are welcome — thank you.

| <img src="assets/icons/wechat.svg" alt="WeChat Pay" title="WeChat Pay" width="32" height="32"> | <img src="assets/icons/alipay.svg" alt="Alipay" title="Alipay" width="32" height="32"> |
| :---: | :---: |
| <a href="assets/donations/wechat-pay.jpg"><img src="assets/donations/wechat-pay.jpg" alt="WeChat Pay donation QR code" width="240"></a> | <a href="assets/donations/alipay.jpg"><img src="assets/donations/alipay.jpg" alt="Alipay donation QR code" width="240"></a> |
| WeChat Pay | Alipay |

## License

[MIT](LICENSE) © 2026 gua.

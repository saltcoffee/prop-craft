export const VIEW_TYPE_PROP_CRAFT = 'propcraft-view';

/** Obsidian-reserved frontmatter keys that PropCraft must never rename or delete. */
export const RESERVED_KEYS = new Set([
  'tags', 'tag', 'aliases', 'alias', 'cssclasses', 'publish', 'permalink', 'publishurl',
]);

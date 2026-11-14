import type { PropCraftSettings } from '../settings-model';

function globToRegExp(glob: string): RegExp {
  let output = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        output += '.*';
        index += 1;
        if (glob[index + 1] === '/') index += 1;
      } else {
        output += '[^/]*';
      }
    } else if (char === '?') {
      output += '[^/]';
    } else {
      output += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${output}$`);
}

export function shouldExclude(path: string, settings: PropCraftSettings): boolean {
  const normalized = path.replace(/^\/+/, '');
  for (const glob of settings.excludeGlobs) {
    if (!glob.trim()) continue;
    if (globToRegExp(glob.trim().replace(/^\/+/, '')).test(normalized)) return true;
  }
  if (settings.excludeTemplates && settings.templateFolder.trim()) {
    const folder = settings.templateFolder.trim().replace(/^\/+|\/+$/g, '');
    if (folder && (normalized === folder || normalized.startsWith(`${folder}/`))) return true;
  }
  return false;
}

export function exclusionFingerprint(settings: PropCraftSettings): string {
  return JSON.stringify([settings.excludeGlobs, settings.excludeTemplates, settings.templateFolder]);
}

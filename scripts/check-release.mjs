import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { extractReleaseNotes } from './release-notes.mjs';

const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const exists = async file => {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
};

const manifest = await readJSON('manifest.json');
const pkg = await readJSON('package.json');
const versions = await readJSON('versions.json');

assert.match(manifest.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
assert.equal(pkg.version, manifest.version, 'Package version must match the manifest');
assert.equal(versions[manifest.version], manifest.minAppVersion, 'versions.json must map the release to minAppVersion');
assert.equal(manifest.id, 'propcraft');
assert.equal(manifest.author, 'gua');
assert.equal(manifest.isDesktopOnly, true, 'PropCraft must remain desktop-only');
assert.ok(manifest.description.length <= 250 && manifest.description.endsWith('.'), 'manifest description must be <=250 chars and end with a period');

let lock = null;
try {
  lock = await readJSON('package-lock.json');
} catch {
  // A lockfile is produced by npm install; release builds require it, but the check can still run before installation.
  console.warn('package-lock.json not found; skipping lockfile version checks.');
}
if (lock) {
  assert.equal(lock.version, manifest.version, 'Lockfile version must match the manifest');
  assert.equal(lock.packages?.['']?.version, manifest.version, 'Lockfile root package must match the manifest');
}

extractReleaseNotes(await readFile('CHANGELOG.md', 'utf8'), manifest.version);

let git;
try {
  git = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim() === 'true';
} catch {
  git = false;
}

const requested = process.argv.indexOf('--version');
if (requested !== -1) {
  const version = process.argv[requested + 1];
  assert.equal(version, manifest.version, 'Requested version must match the manifest');
  assert.ok(git, 'Tag verification requires a git checkout');
  const revision = ref => execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  assert.equal(revision('HEAD'), revision(`refs/tags/${version}`), 'Release must build the exact tagged commit');
  const tree = new Set(
    execFileSync('git', ['ls-tree', '-r', '--name-only', `refs/tags/${version}`], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean),
  );
  assert.ok(![...tree].some(file => file.startsWith('docs/')), 'Local documentation must never enter a release tag');
}

if (git) {
  const trackedDocs = execFileSync('git', ['ls-files', '--', 'docs/'], { encoding: 'utf8' });
  assert.equal(trackedDocs.trim(), '', 'docs/ must remain untracked');
}

for (const file of ['main.js', 'manifest.json', 'styles.css', 'LICENSE', 'README.md', 'README.zh-CN.md']) {
  assert.ok(await exists(file), `${file} is missing or empty`);
}

for (const file of ['README.md', 'README.zh-CN.md']) {
  const source = await readFile(file, 'utf8');
  const targets = [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)|(?:src|href)="([^"]+)"/g)].map(match => match[1] ?? match[2]);
  for (const target of targets) {
    if (/^(?:https?:|#|mailto:)/.test(target)) continue;
    const local = path.posix.normalize(path.posix.join(path.posix.dirname(file), target.split('#')[0]));
    assert.ok(!path.posix.isAbsolute(local) && !local.startsWith('../'), `Reference outside repository: ${local}`);
    assert.ok(!local.startsWith('docs/'), `Public reference to local documentation: ${local}`);
    await readFile(local);
  }
}

async function checkLengths(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkLengths(file);
    else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      const lines = (await readFile(file, 'utf8')).split('\n').length;
      assert.ok(lines <= 600, `${file} exceeds 600 lines (${lines})`);
    }
  }
}
await checkLengths('src');

console.log(`Release checks passed: PropCraft ${manifest.version}, Obsidian ${manifest.minAppVersion}+`);

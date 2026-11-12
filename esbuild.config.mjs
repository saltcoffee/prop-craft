import { context } from 'esbuild';
import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';

const production = process.argv.includes('production');
const banner = `/* PropCraft | MIT | https://github.com/saltcoffee/prop-craft\n\n${await readFile('LICENSE', 'utf8').catch(() => '')}\n*/`;

const builder = await context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  outfile: 'main.js',
  minify: production,
  sourcemap: production ? false : 'inline',
  legalComments: 'inline',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  external: [
    'obsidian', 'electron', '@codemirror/*', '@lezer/common', '@lezer/highlight',
    '@lezer/lr', ...builtinModules, ...builtinModules.map(name => `node:${name}`),
  ],
  banner: { js: banner },
});

if (production) {
  await builder.rebuild();
  await builder.dispose();
} else {
  await builder.watch();
}

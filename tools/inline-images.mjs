#!/usr/bin/env node
// Produce a self-contained IR asset: inline every static image reference as a
// PNG data URI so the native renderer and the web emitter both paint the same
// pixels without any platform asset channel. The source IR on disk is left
// untouched; only the derived asset carries the bytes.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [, , irPath, projectRoot, outPath] = process.argv;
if (!irPath || !projectRoot || !outPath) {
  process.stderr.write('usage: inline-images.mjs <ir.json> <project-root> <out.json>\n');
  process.exit(2);
}

const cache = new Map();
function dataUri(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const clean = rel.replace(/^(\.\/)+/, '');
  // `clean` is already the path relative to the project root,
  // e.g. assets/photo1.png.
  const file = path.resolve(projectRoot, clean);
  let uri = null;
  if (!path.isAbsolute(clean) && !clean.split(/[\\/]/).includes('..')
      && file.startsWith(path.resolve(projectRoot) + path.sep) && existsSync(file)) {
    uri = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  }
  cache.set(rel, uri);
  return uri;
}

function isAsset(v) {
  return typeof v === 'string' && v.includes('assets/')
    && !v.includes('{') && !v.startsWith('data:');
}

function inline(v) {
  if (typeof v === 'string') return isAsset(v) ? (dataUri(v) ?? v) : v;
  if (Array.isArray(v)) return v.map(inline);
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = inline(v[k]);
  }
  return v;
}

const ir = JSON.parse(readFileSync(irPath, 'utf8'));
inline(ir.tree);
for (const decl of ir.state || []) decl.init = inline(decl.init);
writeFileSync(outPath, JSON.stringify(ir));
const inlined = [...cache.values()].filter(Boolean).length;
process.stdout.write(`inlined ${inlined} image(s) into ${outPath}\n`);

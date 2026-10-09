/**
 * Guard: the file list the service worker downloads on install.
 *
 * WHY THIS IS WORTH A TEST. The list is the whole offline shell. A chunk
 * missing from it paints the page and then cannot hydrate offline, and nothing
 * in a build, a typecheck or a lint run notices. The stamp matters as much: it
 * names the worker's cache and is what makes the browser install a new worker,
 * so a stamp that stayed the same across two different builds would strand
 * devices on the old one.
 *
 * Both functions are pure and take plain data, so there is no disk, no build
 * and no clock here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPrecacheManifest, stampServiceWorker } from '../../scripts/build-precache';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A small but realistic build output: hashed chunks, static files, and the files that must stay out. */
const BUILD_FILES = [
  '/sw.js',
  '/precache.json',
  '/assets/entry.client-AAAA1111.js',
  '/assets/offline-BBBB2222.js',
  '/assets/manifest-cccc3333.js',
  '/assets/root-DDDD4444.css',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/fonts/bricolage-grotesque-latin-var.woff2',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/.well-known/security.txt',
  '/robots.txt',
];

describe('buildPrecacheManifest', () => {
  it('lists every asset, icon, font and root static file', () => {
    const { assets } = buildPrecacheManifest(BUILD_FILES);
    assert.deepEqual(assets, [
      '/assets/entry.client-AAAA1111.js',
      '/assets/manifest-cccc3333.js',
      '/assets/offline-BBBB2222.js',
      '/assets/root-DDDD4444.css',
      '/favicon.ico',
      '/favicon.svg',
      '/fonts/bricolage-grotesque-latin-var.woff2',
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/manifest.webmanifest',
    ]);
  });

  it('never lists the worker, the list itself, .well-known or any other root file', () => {
    const { assets } = buildPrecacheManifest(BUILD_FILES);
    for (const excluded of ['/sw.js', '/precache.json', '/.well-known/security.txt', '/robots.txt']) {
      assert.equal(assets.includes(excluded), false, `${excluded} must not be precached`);
    }
  });

  it('does not list a bare directory prefix as a file', () => {
    const { assets } = buildPrecacheManifest(['/assets/', '/icons/', '/assets/real-1.js']);
    assert.deepEqual(assets, ['/assets/real-1.js']);
  });

  it('sorts the list and drops duplicates', () => {
    const { assets } = buildPrecacheManifest(['/assets/b.js', '/assets/a.js', '/assets/b.js']);
    assert.deepEqual(assets, ['/assets/a.js', '/assets/b.js']);
  });

  it('carries version 1, which the worker checks', () => {
    assert.equal(buildPrecacheManifest(BUILD_FILES).version, 1);
  });

  it('makes a stamp of twelve hex characters', () => {
    assert.match(buildPrecacheManifest(BUILD_FILES).stamp, /^[0-9a-f]{12}$/);
  });

  it('gives the same stamp for the same files in any order', () => {
    const forward = buildPrecacheManifest(BUILD_FILES);
    const backward = buildPrecacheManifest([...BUILD_FILES].toReversed());
    assert.equal(forward.stamp, backward.stamp);
  });

  it('ignores files outside the list when stamping', () => {
    const base = buildPrecacheManifest(BUILD_FILES);
    const withExtras = buildPrecacheManifest([...BUILD_FILES, '/another-root-file.txt', '/.well-known/other']);
    assert.equal(base.stamp, withExtras.stamp);
  });

  it('changes the stamp when a hashed file is renamed, added or removed', () => {
    const base = buildPrecacheManifest(BUILD_FILES).stamp;
    const renamed = buildPrecacheManifest(
      BUILD_FILES.map((file) => (file === '/assets/offline-BBBB2222.js' ? '/assets/offline-ZZZZ9999.js' : file)),
    ).stamp;
    const added = buildPrecacheManifest([...BUILD_FILES, '/assets/new-EEEE5555.js']).stamp;
    const removed = buildPrecacheManifest(BUILD_FILES.filter((file) => file !== '/icons/icon-512.png')).stamp;
    assert.equal(new Set([base, renamed, added, removed]).size, 4);
  });
});

describe('stampServiceWorker', () => {
  const PLACEHOLDER = "'__PRECACHE_STAMP__'";

  it('writes the stamp in place of the placeholder', () => {
    const output = stampServiceWorker(`const PRECACHE_STAMP = ${PLACEHOLDER};`, 'abc123def456');
    assert.equal(output, "const PRECACHE_STAMP = 'abc123def456';");
  });

  it('fails loudly when the placeholder is missing', () => {
    assert.throws(() => stampServiceWorker("const PRECACHE_STAMP = 'already-stamped';", 'abc123def456'), /exactly once/);
  });

  it('fails loudly when the placeholder appears twice', () => {
    assert.throws(() => stampServiceWorker(`${PLACEHOLDER}; ${PLACEHOLDER};`, 'abc123def456'), /exactly once/);
  });

  it('finds the placeholder exactly once in the real public/sw.js', () => {
    const source = readFileSync(join(REPO_ROOT, 'public', 'sw.js'), 'utf8');
    const stamped = stampServiceWorker(source, 'abc123def456');
    assert.equal(stamped.includes('__PRECACHE_STAMP__'), false);
    assert.ok(stamped.includes("const PRECACHE_STAMP = 'abc123def456';"));
  });
});

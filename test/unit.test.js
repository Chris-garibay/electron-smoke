import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseHeader } from '../src/binary.js';
import { Asar } from '../src/asar.js';
import { globToRegExp } from '../src/contents.js';
import { namesOtherOs } from '../src/checks/native.js';
import { CODES } from '../src/codes.js';
import { writeAsar } from './fixtures.js';

test('parses thin Mach-O headers', () => {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(0x0100000c, 4);
  b.writeUInt32LE(2, 12);
  assert.deepEqual(parseHeader(b), { format: 'macho', archs: ['arm64'], executable: true });
  b.writeUInt32LE(0x01000007, 4);
  b.writeUInt32LE(6, 12); // dylib
  assert.deepEqual(parseHeader(b), { format: 'macho', archs: ['x64'], executable: false });
});

test('parses universal (fat) Mach-O and rejects Java class files', () => {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(2, 4);
  b.writeUInt32BE(0x01000007, 8);
  b.writeUInt32BE(0x0100000c, 28);
  assert.deepEqual(parseHeader(b).archs, ['x64', 'arm64']);
  b.writeUInt32BE(52, 4); // Java class file major version
  assert.equal(parseHeader(b), null);
});

test('parses ELF and PE headers', () => {
  const elf = Buffer.alloc(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(0xb7, 18);
  assert.deepEqual(parseHeader(elf), { format: 'elf', archs: ['arm64'], executable: true });

  const pe = Buffer.alloc(256);
  pe.set([0x4d, 0x5a]);
  pe.writeUInt32LE(0x80, 0x3c);
  pe.writeUInt32LE(0x00004550, 0x80);
  pe.writeUInt16LE(0x8664, 0x84);
  assert.deepEqual(parseHeader(pe), { format: 'pe', archs: ['x64'], executable: true });
});

test('ignores text files', () => {
  assert.equal(parseHeader(Buffer.from('#!/bin/sh\necho hi\n')), null);
});

test('reads asar archives', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'es-asar-')), 'app.asar');
  writeAsar(p, { 'package.json': '{"main":"a.js"}', 'lib/a.js': 'x', 'node_modules/dep/package.json': '{}' });
  const a = new Asar(p);
  assert.deepEqual([...a.files.keys()].sort(), ['lib/a.js', 'node_modules/dep/package.json', 'package.json']);
  assert.equal(a.read('package.json').toString(), '{"main":"a.js"}');
  assert.equal(a.read('lib/a.js').toString(), 'x');
  assert.equal(a.read('missing'), null);
});

test('glob matching', () => {
  assert.ok(globToRegExp('out/**/*.js').test('out/main/index.js'));
  assert.ok(globToRegExp('out/**/*.js').test('out/index.js'));
  assert.ok(!globToRegExp('out/*.js').test('out/main/index.js'));
  assert.ok(globToRegExp('bin/whisper-?li').test('bin/whisper-cli'));
});

test('detects paths meant for other operating systems', () => {
  assert.ok(namesOtherOs('node_modules/@vscode/deviceid/build/Release/windows.node', 'darwin'));
  assert.ok(namesOtherOs('prebuilds/linux-x64/x.node', 'darwin'));
  assert.ok(!namesOtherOs('prebuilds/darwin-arm64/x.node', 'darwin'));
  assert.ok(!namesOtherOs('build/Release/addon.node', 'darwin'));
});

test('every code has a title and a fix', () => {
  for (const [code, d] of Object.entries(CODES)) {
    assert.match(code, /^[EWI]_[A-Z0-9_]+$/);
    assert.ok(d.title && d.fix, code);
  }
});

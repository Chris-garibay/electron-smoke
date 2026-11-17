// Minimal read-only asar reader. The format is a small binary header that
// holds a JSON index, followed by file contents.
// See https://github.com/electron/asar for the reference implementation.

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

export class Asar {
  constructor(archivePath) {
    this.path = archivePath;
    const fd = openSync(archivePath, 'r');
    try {
      const size = fstatSync(fd).size;
      const pre = Buffer.alloc(16);
      if (readSync(fd, pre, 0, 16, 0) < 16) throw new Error('file too small');
      const headerSize = pre.readUInt32LE(4);
      const jsonSize = pre.readUInt32LE(12);
      if (jsonSize <= 0 || 16 + jsonSize > size) throw new Error('invalid header size');
      const json = Buffer.alloc(jsonSize);
      readSync(fd, json, 0, jsonSize, 16);
      this.header = JSON.parse(json.toString('utf8'));
      this.base = 8 + headerSize;
    } finally {
      closeSync(fd);
    }
    /** @type {Map<string, {size: number, offset: number, unpacked: boolean, link?: string}>} */
    this.files = new Map();
    this.#walk(this.header, '');
  }

  #walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) this.#walk(entry, p);
      else
        this.files.set(p, {
          size: entry.size ?? 0,
          offset: Number(entry.offset ?? 0),
          unpacked: entry.unpacked === true,
          link: entry.link,
        });
    }
  }

  has(p) {
    return this.files.has(p);
  }

  /** Read a packed file. Returns null for unpacked or missing files. */
  read(p) {
    let entry = this.files.get(p);
    if (entry?.link) entry = this.files.get(entry.link);
    if (!entry || entry.unpacked) return null;
    const fd = openSync(this.path, 'r');
    try {
      const buf = Buffer.alloc(entry.size);
      readSync(fd, buf, 0, entry.size, this.base + entry.offset);
      return buf;
    } finally {
      closeSync(fd);
    }
  }
}

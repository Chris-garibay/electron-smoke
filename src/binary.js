// Identify executable formats (Mach-O, ELF, PE) and their CPU architectures
// from file headers, without running anything.

import { open } from 'node:fs/promises';

const MACHO_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32', 12: 'arm' };
const ELF_MACHINE = { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32', 0x28: 'arm' };
const PE_MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32', 0x1c4: 'arm' };

const MH_EXECUTE = 2;

/**
 * @typedef {{ format: 'macho' | 'elf' | 'pe', archs: string[], executable: boolean }} BinaryInfo
 */

/** @returns {BinaryInfo | null} */
export function parseHeader(buf, readAt) {
  if (buf.length < 8) return null;

  // ELF
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    if (buf.length < 20) return null;
    const le = buf[5] === 1;
    const type = le ? buf.readUInt16LE(16) : buf.readUInt16BE(16);
    const machine = le ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
    // ET_EXEC = 2, ET_DYN = 3 (both PIE executables and shared libraries)
    return { format: 'elf', archs: [ELF_MACHINE[machine] ?? `unknown(0x${machine.toString(16)})`], executable: type === 2 || type === 3 };
  }

  // Mach-O thin, 64-bit or 32-bit, little-endian
  const magicLE = buf.readUInt32LE(0);
  if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
    const cpu = buf.readUInt32LE(4);
    const filetype = buf.readUInt32LE(12);
    return { format: 'macho', archs: [MACHO_CPU[cpu] ?? `unknown(0x${cpu.toString(16)})`], executable: filetype === MH_EXECUTE };
  }

  // Mach-O universal ("fat"). 0xcafebabe is also the Java class magic;
  // a real fat header has a small arch count, a Java file has its version here.
  const magicBE = buf.readUInt32BE(0);
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    const n = buf.readUInt32BE(4);
    if (n === 0 || n > 16) return null;
    const entry = magicBE === 0xcafebabf ? 32 : 20;
    const archs = [];
    for (let i = 0; i < n; i++) {
      const off = 8 + i * entry;
      if (off + 4 > buf.length) break;
      const cpu = buf.readUInt32BE(off);
      archs.push(MACHO_CPU[cpu] ?? `unknown(0x${cpu.toString(16)})`);
    }
    // Slice file types are not checked here; treat as executable when the
    // caller has no better information (extension, mode bits).
    return { format: 'macho', archs, executable: true };
  }

  // PE (Windows)
  if (buf[0] === 0x4d && buf[1] === 0x5a && buf.length >= 0x40) {
    const peOffset = buf.readUInt32LE(0x3c);
    const pe = readAt ? readAt(peOffset, 6) : buf.subarray(peOffset, peOffset + 6);
    if (!pe || pe.length < 6 || pe.readUInt32LE(0) !== 0x00004550) return null;
    const machine = pe.readUInt16LE(4);
    return { format: 'pe', archs: [PE_MACHINE[machine] ?? `unknown(0x${machine.toString(16)})`], executable: true };
  }

  return null;
}

/** Read a file's header and identify it. Returns null for non-binaries. */
export async function inspectBinary(file) {
  let fh;
  try {
    fh = await open(file, 'r');
    const head = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(head, 0, 4096, 0);
    const buf = head.subarray(0, bytesRead);
    // PE headers can sit past the first 4 KiB; read them lazily.
    const extra = new Map();
    if (buf.length >= 0x40 && buf[0] === 0x4d && buf[1] === 0x5a) {
      const off = buf.readUInt32LE(0x3c);
      if (off + 6 > buf.length && off < 64 * 1024 * 1024) {
        const pe = Buffer.alloc(6);
        await fh.read(pe, 0, 6, off);
        extra.set(off, pe);
      }
    }
    return parseHeader(buf, (off, len) => extra.get(off) ?? buf.subarray(off, off + len));
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

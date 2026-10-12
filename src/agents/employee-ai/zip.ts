import { createHash } from 'node:crypto';

/**
 * Prompts17 Phase 18 — Dependency-free ZIP writer.
 *
 * AIOS has no third-party archive dependency, so the artifact packager embeds a
 * minimal, standard-compliant ZIP writer: STORE method only, CRC-32 checksums,
 * little-endian fields, and a central directory + EOCD. This is the same format
 * every zip client on earth accepts (a real, extractable artifact — never a fake
 * file).
 */

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly crc: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ (data[i] ?? 0)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}
function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function textEncoder(): { encode(value: string): Uint8Array } {
  return new TextEncoder();
}

/**
 * Builds a valid STORE-method ZIP archive. `entries` is ordered; directory
 * entries are derived from file names. Throws when a name is unsafe (absolute,
 * traversal, NUL) so packaging can never escape the workspace.
 */
export function createZip(
  entries: ReadonlyArray<{ readonly name: string; readonly content: string | Uint8Array }>,
): Uint8Array {
  const encoder = textEncoder();
  const prepared: ZipEntry[] = entries.map((entry) => {
    if (
      entry.name.length === 0 ||
      entry.name.includes('\0') ||
      entry.name.startsWith('/') ||
      /^[a-zA-Z]:/.test(entry.name) ||
      entry.name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error(`unsafe zip entry name: ${entry.name}`);
    }
    const data = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
    return { name: entry.name, data, crc: crc32(data) >>> 0 };
  });

  const localParts: Array<{ offset: number; data: Uint8Array }> = [];
  const centralParts: Array<{ name: string; size: number; localOffset: number; crc: number }> = [];
  let offset = 0;

  for (const entry of prepared) {
    const nameBytes = encoder.encode(entry.name);
    const headerSize = 30 + nameBytes.length;
    const totalSize = headerSize + entry.data.byteLength;
    const local = new Uint8Array(totalSize);
    const view = new DataView(local.buffer);

    writeUint32(view, 0, 0x04034b50); // local file header signature
    writeUint16(view, 4, 20); // version needed to extract
    writeUint16(view, 6, 0x0800); // general purpose flag bit 11: UTF-8 name
    writeUint16(view, 8, 0); // storage method: STORE
    writeUint16(view, 10, 0); // mod time
    writeUint16(view, 12, 0x21); // mod date (1980-01-01)
    writeUint32(view, 14, entry.crc);
    writeUint32(view, 18, entry.data.byteLength); // compressed size = raw (STORE)
    writeUint32(view, 22, entry.data.byteLength); // uncompressed size
    writeUint16(view, 26, nameBytes.length);
    writeUint16(view, 28, 0); // extra length
    local.set(nameBytes, 30);
    local.set(entry.data, headerSize);

    localParts.push({ offset, data: local });
    centralParts.push({
      name: entry.name,
      size: entry.data.byteLength,
      localOffset: offset,
      crc: entry.crc,
    });
    offset += totalSize;
  }

  const centralStart = offset;
  const centralChunks: Uint8Array[] = [];
  for (const entry of centralParts) {
    const nameBytes = encoder.encode(entry.name);
    const record = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(record.buffer);
    writeUint32(view, 0, 0x02014b50); // central directory signature
    writeUint16(view, 4, 20); // version made by
    writeUint16(view, 6, 20); // version needed
    writeUint16(view, 8, 0x0800); // UTF-8 flag
    writeUint16(view, 10, 0); // method: STORE
    writeUint16(view, 12, 0);
    writeUint16(view, 14, 0x21);
    writeUint32(view, 16, entry.crc);
    writeUint32(view, 20, entry.size);
    writeUint32(view, 24, entry.size);
    writeUint16(view, 28, nameBytes.length);
    writeUint16(view, 30, 0); // extra length
    writeUint16(view, 32, 0); // comment length
    writeUint16(view, 34, 0); // disk number start
    writeUint16(view, 36, 0); // internal attrs
    writeUint32(view, 38, 0); // external attrs
    writeUint32(view, 42, entry.localOffset);
    record.set(nameBytes, 46);
    centralChunks.push(record);
  }

  const commentBytes: Uint8Array[] = [];
  const eocd = new Uint8Array(22 + commentBytes.length);
  const eocdView = new DataView(eocd.buffer);
  writeUint32(eocdView, 0, 0x06054b50); // EOCD signature
  writeUint16(eocdView, 4, 0);
  writeUint16(eocdView, 6, 0);
  writeUint16(eocdView, 8, centralParts.length);
  writeUint16(eocdView, 10, centralParts.length);
  writeUint32(
    eocdView,
    12,
    centralChunks.reduce((acc, chunk) => acc + chunk.byteLength, 0),
  );
  writeUint32(eocdView, 16, centralStart);
  writeUint16(eocdView, 20, commentBytes.length);

  const total =
    localParts.reduce((acc, part) => acc + part.data.byteLength, 0) +
    centralChunks.reduce((acc, chunk) => acc + chunk.byteLength, 0) +
    eocd.byteLength;
  const archive = new Uint8Array(total);
  let cursor = 0;
  for (const part of localParts) {
    archive.set(part.data, cursor);
    cursor += part.data.byteLength;
  }
  for (const chunk of centralChunks) {
    archive.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  archive.set(eocd, cursor);
  return archive;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

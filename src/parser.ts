import {
  SQUASHFS_MAGIC,
  SUPERBLOCK_SIZE,
  type Superblock,
  type CompressorId,
  type DecompressFn,
} from './types.js';

export function parseSuperblock(buf: ArrayBuffer): Superblock {
  if (buf.byteLength < SUPERBLOCK_SIZE) {
    throw new Error(`Buffer too small for superblock: ${buf.byteLength} < ${SUPERBLOCK_SIZE}`);
  }
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== SQUASHFS_MAGIC) {
    throw new Error(`Bad magic: 0x${magic.toString(16)} (expected 0x${SQUASHFS_MAGIC.toString(16)})`);
  }
  return {
    magic,
    inodeCount: dv.getUint32(4, true),
    modTime: dv.getUint32(8, true),
    blockSize: dv.getUint32(12, true),
    fragCount: dv.getUint32(16, true),
    compressor: dv.getUint16(20, true) as CompressorId,
    blockLog: dv.getUint16(22, true),
    flags: dv.getUint16(24, true),
    idCount: dv.getUint16(26, true),
    versionMajor: dv.getUint16(28, true),
    versionMinor: dv.getUint16(30, true),
    rootInodeRef: dv.getBigUint64(32, true),
    bytesUsed: dv.getBigUint64(40, true),
    idTableOffset: dv.getBigUint64(48, true),
    xattrTableOffset: dv.getBigUint64(56, true),
    inodeTableOffset: dv.getBigUint64(64, true),
    dirTableOffset: dv.getBigUint64(72, true),
    fragTableOffset: dv.getBigUint64(80, true),
    exportTableOffset: dv.getBigUint64(88, true),
  };
}

export function readMetadataBlock(
  buf: ArrayBuffer,
  offset: number,
  decompress: DecompressFn,
): { data: Uint8Array; diskSize: number } {
  const dv = new DataView(buf, offset, 2);
  const header = dv.getUint16(0, true);
  const isUncompressed = (header & 0x8000) !== 0;
  const size = header & 0x7fff;
  const payload = new Uint8Array(buf, offset + 2, size);
  const data = isUncompressed ? payload.slice() : decompress(payload);
  return { data, diskSize: 2 + size };
}

export function decodeMetadataRef(ref: bigint): { blockOffset: number; byteOffset: number } {
  return {
    blockOffset: Number(ref >> 16n),
    byteOffset: Number(ref & 0xffffn),
  };
}

export interface ParsedInode {
  type: number;
  permissions: number;
  uid: number;
  gid: number;
  mtime: number;
  inodeNumber: number;
  fileSize?: number;
  fragIndex?: number;
  blockOffset?: number;
  blocksStart?: number;
  blockSizes?: number[];
  dirBlockIndex?: number;
  dirLinkCount?: number;
  dirFileSize?: number;
  dirBlockOffset?: number;
  parentInode?: number;
}

export function parseInodeHeader(data: Uint8Array, offset: number): ParsedInode {
  const dv = new DataView(data.buffer, data.byteOffset + offset);
  return {
    type: dv.getUint16(0, true),
    permissions: dv.getUint16(2, true),
    uid: dv.getUint16(4, true),
    gid: dv.getUint16(6, true),
    mtime: dv.getUint32(8, true),
    inodeNumber: dv.getUint32(12, true),
  };
}

export function parseBasicFileInode(data: Uint8Array, offset: number, blockSize: number): ParsedInode {
  const base = parseInodeHeader(data, offset);
  const dv = new DataView(data.buffer, data.byteOffset + offset + 16);
  base.blocksStart = dv.getUint32(0, true);
  base.fragIndex = dv.getUint32(4, true);
  base.blockOffset = dv.getUint32(8, true);
  base.fileSize = dv.getUint32(12, true);
  const hasFragment = base.fragIndex !== 0xffffffff;
  const blockCount = hasFragment
    ? Math.floor(base.fileSize / blockSize)
    : Math.ceil(base.fileSize / blockSize);
  base.blockSizes = [];
  for (let i = 0; i < blockCount; i++) {
    base.blockSizes.push(dv.getUint32(16 + i * 4, true));
  }
  return base;
}

export function parseBasicDirInode(data: Uint8Array, offset: number): ParsedInode {
  const base = parseInodeHeader(data, offset);
  const dv = new DataView(data.buffer, data.byteOffset + offset + 16);
  base.dirBlockIndex = dv.getUint32(0, true);
  base.dirLinkCount = dv.getUint32(4, true);
  base.dirFileSize = dv.getUint16(8, true);
  base.dirBlockOffset = dv.getUint16(10, true);
  base.parentInode = dv.getUint32(12, true);
  return base;
}

export interface DirEntry {
  name: string;
  inodeOffset: number;
  inodeDelta: number;
  type: number;
}

export function parseDirEntries(data: Uint8Array, offset: number, size: number): DirEntry[] {
  const entries: DirEntry[] = [];
  const dv = new DataView(data.buffer, data.byteOffset);
  let pos = offset;
  const end = offset + size - 3;
  while (pos < end) {
    const count = dv.getUint32(pos, true) + 1;
    const _start = dv.getUint32(pos + 4, true);
    const _refInode = dv.getUint32(pos + 8, true);
    pos += 12;
    for (let i = 0; i < count; i++) {
      const entryOffset = dv.getUint16(pos, true);
      const inodeDelta = dv.getInt16(pos + 2, true);
      const type = dv.getUint16(pos + 4, true);
      const nameSize = dv.getUint16(pos + 6, true) + 1;
      const nameBytes = data.slice(pos + 8, pos + 8 + nameSize);
      const name = new TextDecoder().decode(nameBytes);
      entries.push({ name, inodeOffset: entryOffset, inodeDelta, type });
      pos += 8 + nameSize;
    }
  }
  return entries;
}

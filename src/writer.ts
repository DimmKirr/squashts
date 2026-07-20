import {
  SQUASHFS_MAGIC,
  SUPERBLOCK_SIZE,
  METADATA_BLOCK_SIZE,
  NO_XATTR,
  Compressor,
  SuperblockFlags,
  InodeType,
  type SquashfsFile,
  type CompressFn,
} from './types.js';

const DEFAULT_BLOCK_SIZE = 131072;
const DEFAULT_BLOCK_LOG = 17;

function writeMetadataBlock(data: Uint8Array, compress: CompressFn): Uint8Array {
  const compressed = compress(data);
  if (compressed.length < data.length) {
    const block = new Uint8Array(2 + compressed.length);
    new DataView(block.buffer).setUint16(0, compressed.length, true);
    block.set(compressed, 2);
    return block;
  }
  const block = new Uint8Array(2 + data.length);
  new DataView(block.buffer).setUint16(0, data.length | 0x8000, true);
  block.set(data, 2);
  return block;
}

function buildLookupTable(
  raw: Uint8Array,
  compress: CompressFn,
  diskBase: number,
): { metaBlocks: Uint8Array; index: Uint8Array } {
  const chunks: Uint8Array[] = [];
  const offsets: bigint[] = [];
  let diskPos = diskBase;

  for (let i = 0; i < raw.length; i += METADATA_BLOCK_SIZE) {
    const chunk = raw.slice(i, Math.min(i + METADATA_BLOCK_SIZE, raw.length));
    offsets.push(BigInt(diskPos));
    const mb = writeMetadataBlock(chunk, compress);
    chunks.push(mb);
    diskPos += mb.length;
  }

  const totalMeta = chunks.reduce((s, c) => s + c.length, 0);
  const metaBlocks = new Uint8Array(totalMeta);
  let pos = 0;
  for (const c of chunks) {
    metaBlocks.set(c, pos);
    pos += c.length;
  }

  const index = new Uint8Array(offsets.length * 8);
  const idv = new DataView(index.buffer);
  for (let i = 0; i < offsets.length; i++) {
    idv.setBigUint64(i * 8, offsets[i], true);
  }
  return { metaBlocks, index };
}

function encodeInodeRef(blockOffset: number, byteOffset: number): bigint {
  return (BigInt(blockOffset) << 16n) | BigInt(byteOffset);
}

export function buildSquashfs(
  files: SquashfsFile[],
  compress: CompressFn,
  options?: { modTime?: number },
): Uint8Array {
  const modTime = options?.modTime ?? 0;
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const inodeCount = sorted.length + 1;

  // Fragment block: concatenate all file data, compress
  const totalFileData = sorted.reduce((s, f) => s + f.data.length, 0);
  const fragRaw = new Uint8Array(totalFileData);
  const fileOffsets: number[] = [];
  let fragPos = 0;
  for (const f of sorted) {
    fileOffsets.push(fragPos);
    fragRaw.set(f.data, fragPos);
    fragPos += f.data.length;
  }

  const fragCompressed = compress(fragRaw);
  const fragUncompressed = fragCompressed.length >= fragRaw.length;
  const fragDisk = fragUncompressed ? fragRaw.slice() : fragCompressed;
  const fragDiskSize = fragDisk.length;
  const fragBlockOffset = SUPERBLOCK_SIZE;

  // Inode table
  const INODE_HEADER_SIZE = 16;
  const FILE_INODE_EXTRA = 16;
  const DIR_INODE_EXTRA = 16;
  const fileInodeSize = INODE_HEADER_SIZE + FILE_INODE_EXTRA;
  const dirInodeSize = INODE_HEADER_SIZE + DIR_INODE_EXTRA;

  const inodeRaw = new Uint8Array(sorted.length * fileInodeSize + dirInodeSize);
  const inodeDv = new DataView(inodeRaw.buffer);
  let iOff = 0;

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    inodeDv.setUint16(iOff + 0, InodeType.BASIC_FILE, true);
    inodeDv.setUint16(iOff + 2, f.mode & 0xfff, true);
    inodeDv.setUint16(iOff + 4, 0, true);
    inodeDv.setUint16(iOff + 6, 0, true);
    inodeDv.setUint32(iOff + 8, modTime, true);
    inodeDv.setUint32(iOff + 12, i + 1, true);
    inodeDv.setUint32(iOff + 16, 0, true);
    inodeDv.setUint32(iOff + 20, 0, true);
    inodeDv.setUint32(iOff + 24, fileOffsets[i], true);
    inodeDv.setUint32(iOff + 28, f.data.length, true);
    iOff += fileInodeSize;
  }

  // Directory table (need size for dir inode)
  const encoder = new TextEncoder();
  const dirEntryParts: { offset: number; delta: number; type: number; name: Uint8Array }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    dirEntryParts.push({
      offset: i * fileInodeSize,
      delta: i,
      type: InodeType.BASIC_FILE,
      name: encoder.encode(sorted[i].name),
    });
  }
  const dirHeaderSize = 12;
  const dirEntriesSize = dirEntryParts.reduce((s, e) => s + 8 + e.name.length, 0);
  const dirRawSize = dirHeaderSize + dirEntriesSize;
  const dirFileSize = dirRawSize + 3;

  // Root dir inode
  const rootInodeByteOffset = iOff;
  inodeDv.setUint16(iOff + 0, InodeType.BASIC_DIR, true);
  inodeDv.setUint16(iOff + 2, 0o755, true);
  inodeDv.setUint16(iOff + 4, 0, true);
  inodeDv.setUint16(iOff + 6, 0, true);
  inodeDv.setUint32(iOff + 8, modTime, true);
  inodeDv.setUint32(iOff + 12, inodeCount, true);
  inodeDv.setUint32(iOff + 16, 0, true);
  inodeDv.setUint32(iOff + 20, 2, true);
  inodeDv.setUint16(iOff + 24, dirFileSize, true);
  inodeDv.setUint16(iOff + 26, 0, true);
  inodeDv.setUint32(iOff + 28, inodeCount + 1, true);

  const inodeTableOffset = fragBlockOffset + fragDiskSize;
  const inodeMetaBlock = writeMetadataBlock(inodeRaw, compress);

  // Build directory table
  const dirRaw = new Uint8Array(dirRawSize);
  const dirDv = new DataView(dirRaw.buffer);
  let dOff = 0;
  dirDv.setUint32(dOff + 0, sorted.length - 1, true);
  dirDv.setUint32(dOff + 4, 0, true);
  dirDv.setUint32(dOff + 8, 1, true);
  dOff += dirHeaderSize;
  for (const e of dirEntryParts) {
    dirDv.setUint16(dOff + 0, e.offset, true);
    dirDv.setInt16(dOff + 2, e.delta, true);
    dirDv.setUint16(dOff + 4, e.type, true);
    dirDv.setUint16(dOff + 6, e.name.length - 1, true);
    dirRaw.set(e.name, dOff + 8);
    dOff += 8 + e.name.length;
  }

  const dirTableOffset = inodeTableOffset + inodeMetaBlock.length;
  const dirMetaBlock = writeMetadataBlock(dirRaw, compress);

  // Fragment table
  const fragEntryRaw = new Uint8Array(16);
  const feDv = new DataView(fragEntryRaw.buffer);
  feDv.setBigUint64(0, BigInt(fragBlockOffset), true);
  let fragSizeField = fragDiskSize;
  if (fragUncompressed) fragSizeField |= (1 << 24);
  feDv.setUint32(8, fragSizeField, true);
  feDv.setUint32(12, 0, true);

  const fragTableMetaBase = dirTableOffset + dirMetaBlock.length;
  const fragLookup = buildLookupTable(fragEntryRaw, compress, fragTableMetaBase);

  // ID table
  const idEntryRaw = new Uint8Array(4);
  new DataView(idEntryRaw.buffer).setUint32(0, 0, true);

  const idTableMetaBase = fragTableMetaBase + fragLookup.metaBlocks.length + fragLookup.index.length;
  const idLookup = buildLookupTable(idEntryRaw, compress, idTableMetaBase);

  // Compute offsets
  const fragTableIndexOffset = fragTableMetaBase + fragLookup.metaBlocks.length;
  const idTableIndexOffset = idTableMetaBase + idLookup.metaBlocks.length;
  const bytesUsed = idTableIndexOffset + idLookup.index.length;
  const padded = Math.ceil(bytesUsed / 4096) * 4096;
  const out = new Uint8Array(padded);
  const outDv = new DataView(out.buffer);

  // Superblock
  outDv.setUint32(0, SQUASHFS_MAGIC, true);
  outDv.setUint32(4, inodeCount, true);
  outDv.setUint32(8, modTime, true);
  outDv.setUint32(12, DEFAULT_BLOCK_SIZE, true);
  outDv.setUint32(16, 1, true);
  outDv.setUint16(20, Compressor.GZIP, true);
  outDv.setUint16(22, DEFAULT_BLOCK_LOG, true);
  const flags = SuperblockFlags.NO_XATTRS | SuperblockFlags.ALWAYS_FRAGMENTS | SuperblockFlags.DUPLICATES;
  outDv.setUint16(24, flags, true);
  outDv.setUint16(26, 1, true);
  outDv.setUint16(28, 4, true);
  outDv.setUint16(30, 0, true);
  outDv.setBigUint64(32, encodeInodeRef(0, rootInodeByteOffset), true);
  outDv.setBigUint64(40, BigInt(bytesUsed), true);
  outDv.setBigUint64(48, BigInt(idTableIndexOffset), true);
  outDv.setBigUint64(56, NO_XATTR, true);
  outDv.setBigUint64(64, BigInt(inodeTableOffset), true);
  outDv.setBigUint64(72, BigInt(dirTableOffset), true);
  outDv.setBigUint64(80, BigInt(fragTableIndexOffset), true);
  outDv.setBigUint64(88, NO_XATTR, true);

  // Data sections
  out.set(fragDisk, fragBlockOffset);
  out.set(inodeMetaBlock, inodeTableOffset);
  out.set(dirMetaBlock, dirTableOffset);
  out.set(fragLookup.metaBlocks, fragTableMetaBase);
  out.set(fragLookup.index, fragTableIndexOffset);
  out.set(idLookup.metaBlocks, idTableMetaBase);
  out.set(idLookup.index, idTableIndexOffset);

  return out;
}

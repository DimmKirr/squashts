import {
  SQUASHFS_MAGIC,
  SUPERBLOCK_SIZE,
  METADATA_BLOCK_SIZE,
  NO_XATTR,
  NO_FRAGMENT,
  Compressor,
  SuperblockFlags,
  InodeType,
  type SquashfsFile,
  type CompressFn,
} from './types.js';

const DEFAULT_BLOCK_SIZE = 131072; // 128 KiB
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

interface DataBlockInfo {
  diskSize: number;
  isUncompressed: boolean;
}

interface FileLayout {
  startBlock: number;
  dataBlocks: DataBlockInfo[];
  fragmentIndex: number;
  fragmentOffset: number;
}

export function buildSquashfs(
  files: SquashfsFile[],
  compress: CompressFn,
  options?: { modTime?: number },
): Uint8Array {
  const modTime = options?.modTime ?? 0;
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const inodeCount = sorted.length + 1;

  // Phase 1: write data blocks for large files (>= block size)
  const dataChunks: Uint8Array[] = [];
  let diskPos = SUPERBLOCK_SIZE;
  const fileLayouts: FileLayout[] = [];

  for (const f of sorted) {
    if (f.data.length >= DEFAULT_BLOCK_SIZE) {
      const blocks: DataBlockInfo[] = [];
      const startBlock = diskPos;
      const numFullBlocks = Math.floor(f.data.length / DEFAULT_BLOCK_SIZE);

      for (let b = 0; b < numFullBlocks; b++) {
        const chunk = f.data.slice(b * DEFAULT_BLOCK_SIZE, (b + 1) * DEFAULT_BLOCK_SIZE);
        const compressed = compress(chunk);
        const isUncompressed = compressed.length >= chunk.length;
        const blockData = isUncompressed ? chunk : compressed;
        blocks.push({ diskSize: blockData.length, isUncompressed });
        dataChunks.push(blockData);
        diskPos += blockData.length;
      }

      fileLayouts.push({
        startBlock,
        dataBlocks: blocks,
        fragmentIndex: -1, // will be set in phase 2 if there's a tail
        fragmentOffset: 0,
      });
    } else {
      fileLayouts.push({
        startBlock: 0,
        dataBlocks: [],
        fragmentIndex: -1,
        fragmentOffset: 0,
      });
    }
  }

  const dataBlocksDiskEnd = diskPos;

  // Phase 2: build fragment blocks
  // Collect fragment data: small files entirely, large file tails
  const fragmentPieces: { sortIndex: number; data: Uint8Array }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    if (f.data.length >= DEFAULT_BLOCK_SIZE) {
      const tail = f.data.length % DEFAULT_BLOCK_SIZE;
      if (tail > 0) {
        fragmentPieces.push({
          sortIndex: i,
          data: f.data.slice(f.data.length - tail),
        });
      }
    } else {
      fragmentPieces.push({ sortIndex: i, data: f.data });
    }
  }

  // Pack fragments into blocks of at most DEFAULT_BLOCK_SIZE
  const fragBlockEntries: { diskOffset: number; diskSize: number; isUncompressed: boolean }[] = [];
  const fragBlockDatas: Uint8Array[] = [];
  let currentFragRaw = new Uint8Array(DEFAULT_BLOCK_SIZE);
  let currentFragPos = 0;
  let currentFragDiskOffset = dataBlocksDiskEnd;

  function flushFragBlock() {
    if (currentFragPos === 0) return;
    const raw = currentFragRaw.slice(0, currentFragPos);
    const compressed = compress(raw);
    const isUncompressed = compressed.length >= raw.length;
    const blockData = isUncompressed ? raw : compressed;
    fragBlockEntries.push({
      diskOffset: currentFragDiskOffset,
      diskSize: blockData.length,
      isUncompressed,
    });
    fragBlockDatas.push(blockData);
    currentFragDiskOffset += blockData.length;
    currentFragRaw = new Uint8Array(DEFAULT_BLOCK_SIZE);
    currentFragPos = 0;
  }

  for (const piece of fragmentPieces) {
    if (currentFragPos + piece.data.length > DEFAULT_BLOCK_SIZE && currentFragPos > 0) {
      flushFragBlock();
    }
    const fragIndex = fragBlockEntries.length + (currentFragPos > 0 ? 0 : 0);
    const fragBlockIdx = fragBlockEntries.length;
    fileLayouts[piece.sortIndex].fragmentIndex = fragBlockIdx;
    fileLayouts[piece.sortIndex].fragmentOffset = currentFragPos;
    currentFragRaw.set(piece.data, currentFragPos);
    currentFragPos += piece.data.length;
  }
  flushFragBlock();

  const fragCount = fragBlockEntries.length;
  const fragDiskEnd = currentFragDiskOffset;

  // Phase 3: build inode table
  const INODE_HEADER_SIZE = 16;
  const FILE_INODE_FIXED = 16; // start_block + fragment + offset + file_size
  const DIR_INODE_EXTRA = 16;

  // Compute inode sizes (variable due to block_sizes arrays)
  const inodeSizes: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const numBlocks = fileLayouts[i].dataBlocks.length;
    inodeSizes.push(INODE_HEADER_SIZE + FILE_INODE_FIXED + numBlocks * 4);
  }
  const dirInodeSize = INODE_HEADER_SIZE + DIR_INODE_EXTRA;
  const totalInodeSize = inodeSizes.reduce((s, sz) => s + sz, 0) + dirInodeSize;

  const inodeRaw = new Uint8Array(totalInodeSize);
  const inodeDv = new DataView(inodeRaw.buffer);
  const inodeByteOffsets: number[] = [];
  let iOff = 0;

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    const layout = fileLayouts[i];
    inodeByteOffsets.push(iOff);

    inodeDv.setUint16(iOff + 0, InodeType.BASIC_FILE, true);
    inodeDv.setUint16(iOff + 2, f.mode & 0xfff, true);
    inodeDv.setUint16(iOff + 4, 0, true); // uid
    inodeDv.setUint16(iOff + 6, 0, true); // guid
    inodeDv.setUint32(iOff + 8, modTime, true);
    inodeDv.setUint32(iOff + 12, i + 1, true); // inode_number

    inodeDv.setUint32(iOff + 16, layout.startBlock, true);
    inodeDv.setUint32(iOff + 20,
      layout.fragmentIndex >= 0 ? layout.fragmentIndex : NO_FRAGMENT, true);
    inodeDv.setUint32(iOff + 24, layout.fragmentOffset, true);
    inodeDv.setUint32(iOff + 28, f.data.length, true);

    // block_sizes array
    let bOff = iOff + 32;
    for (const block of layout.dataBlocks) {
      let sizeField = block.diskSize;
      if (block.isUncompressed) sizeField |= (1 << 24);
      inodeDv.setUint32(bOff, sizeField, true);
      bOff += 4;
    }

    iOff = bOff;
  }

  // Directory table
  const encoder = new TextEncoder();
  const dirEntryParts: { inodeByteOffset: number; delta: number; type: number; name: Uint8Array }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    dirEntryParts.push({
      inodeByteOffset: inodeByteOffsets[i],
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
  inodeDv.setUint32(iOff + 16, 0, true); // start_block (dir table offset relative)
  inodeDv.setUint32(iOff + 20, 2, true); // nlink
  inodeDv.setUint16(iOff + 24, dirFileSize, true);
  inodeDv.setUint16(iOff + 26, 0, true); // offset
  inodeDv.setUint32(iOff + 28, inodeCount + 1, true); // parent_inode

  const inodeTableOffset = fragDiskEnd;
  const inodeMetaBlock = writeMetadataBlock(inodeRaw, compress);

  // Build directory table
  const dirRaw = new Uint8Array(dirRawSize);
  const dirDv = new DataView(dirRaw.buffer);
  let dOff = 0;
  dirDv.setUint32(dOff + 0, sorted.length - 1, true); // count - 1
  dirDv.setUint32(dOff + 4, 0, true); // start (inode meta block index)
  dirDv.setUint32(dOff + 8, 1, true); // inode_number of first entry
  dOff += dirHeaderSize;
  for (const e of dirEntryParts) {
    dirDv.setUint16(dOff + 0, e.inodeByteOffset, true); // offset into uncompressed inode block
    dirDv.setInt16(dOff + 2, e.delta, true);
    dirDv.setUint16(dOff + 4, e.type, true);
    dirDv.setUint16(dOff + 6, e.name.length - 1, true);
    dirRaw.set(e.name, dOff + 8);
    dOff += 8 + e.name.length;
  }

  const dirTableOffset = inodeTableOffset + inodeMetaBlock.length;
  const dirMetaBlock = writeMetadataBlock(dirRaw, compress);

  // Fragment table entries (16 bytes each: u64 start + u32 size + u32 unused)
  const fragEntryRaw = new Uint8Array(fragCount * 16);
  const feDv = new DataView(fragEntryRaw.buffer);
  for (let i = 0; i < fragCount; i++) {
    const entry = fragBlockEntries[i];
    feDv.setBigUint64(i * 16, BigInt(entry.diskOffset), true);
    let sizeField = entry.diskSize;
    if (entry.isUncompressed) sizeField |= (1 << 24);
    feDv.setUint32(i * 16 + 8, sizeField, true);
    feDv.setUint32(i * 16 + 12, 0, true);
  }

  const fragTableMetaBase = dirTableOffset + dirMetaBlock.length;
  const fragLookup = fragCount > 0
    ? buildLookupTable(fragEntryRaw, compress, fragTableMetaBase)
    : { metaBlocks: new Uint8Array(0), index: new Uint8Array(0) };

  // ID table
  const idEntryRaw = new Uint8Array(4);
  new DataView(idEntryRaw.buffer).setUint32(0, 0, true);

  const idTableMetaBase = fragTableMetaBase + fragLookup.metaBlocks.length + fragLookup.index.length;
  const idLookup = buildLookupTable(idEntryRaw, compress, idTableMetaBase);

  // Compute final offsets
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
  outDv.setUint32(16, fragCount, true);
  outDv.setUint16(20, Compressor.GZIP, true);
  outDv.setUint16(22, DEFAULT_BLOCK_LOG, true);
  const flags = SuperblockFlags.NO_XATTRS | SuperblockFlags.ALWAYS_FRAGMENTS | SuperblockFlags.DUPLICATES;
  outDv.setUint16(24, flags, true);
  outDv.setUint16(26, 1, true); // id count
  outDv.setUint16(28, 4, true); // version major
  outDv.setUint16(30, 0, true); // version minor
  outDv.setBigUint64(32, encodeInodeRef(0, rootInodeByteOffset), true);
  outDv.setBigUint64(40, BigInt(bytesUsed), true);
  outDv.setBigUint64(48, BigInt(idTableIndexOffset), true);
  outDv.setBigUint64(56, NO_XATTR, true);
  outDv.setBigUint64(64, BigInt(inodeTableOffset), true);
  outDv.setBigUint64(72, BigInt(dirTableOffset), true);
  outDv.setBigUint64(80, BigInt(fragTableIndexOffset), true);
  outDv.setBigUint64(88, NO_XATTR, true);

  // Write data blocks
  let dataPos = SUPERBLOCK_SIZE;
  for (const chunk of dataChunks) {
    out.set(chunk, dataPos);
    dataPos += chunk.length;
  }

  // Write fragment blocks
  for (const fb of fragBlockDatas) {
    out.set(fb, fragBlockEntries[fragBlockDatas.indexOf(fb)].diskOffset);
  }

  // Write metadata
  out.set(inodeMetaBlock, inodeTableOffset);
  out.set(dirMetaBlock, dirTableOffset);
  if (fragLookup.metaBlocks.length > 0) {
    out.set(fragLookup.metaBlocks, fragTableMetaBase);
    out.set(fragLookup.index, fragTableIndexOffset);
  }
  out.set(idLookup.metaBlocks, idTableMetaBase);
  out.set(idLookup.index, idTableIndexOffset);

  return out;
}

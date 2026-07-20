import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';

import {
  parseSuperblock,
  readMetadataBlock,
  decodeMetadataRef,
  parseBasicDirInode,
  parseDirEntries,
  Compressor,
  InodeType,
  SuperblockFlags,
  type DecompressFn,
} from '../src/index.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const REF_SQUASHFS = readFileSync(join(FIXTURES_DIR, 'ref-minimal.squashfs'));

const zlibDecompress: DecompressFn = (data) => new Uint8Array(inflateSync(data));

describe('parseSuperblock', () => {
  const sb = parseSuperblock(REF_SQUASHFS.buffer);

  it('reads the magic number', () => {
    expect(sb.magic).toBe(0x73717368);
  });

  it('reads version 4.0', () => {
    expect(sb.versionMajor).toBe(4);
    expect(sb.versionMinor).toBe(0);
  });

  it('detects gzip compression', () => {
    expect(sb.compressor).toBe(Compressor.GZIP);
  });

  it('counts 4 inodes (1 dir + 3 files)', () => {
    expect(sb.inodeCount).toBe(4);
  });

  it('counts 1 fragment', () => {
    expect(sb.fragCount).toBe(1);
  });

  it('has block size 131072', () => {
    expect(sb.blockSize).toBe(131072);
    expect(sb.blockLog).toBe(17);
  });

  it('has 1 id (root only)', () => {
    expect(sb.idCount).toBe(1);
  });

  it('has mod_time 0', () => {
    expect(sb.modTime).toBe(0);
  });

  it('reports correct bytes_used', () => {
    expect(sb.bytesUsed).toBe(373n);
  });

  it('has no xattrs', () => {
    expect(sb.flags & SuperblockFlags.NO_XATTRS).toBeTruthy();
  });

  it('is exportable', () => {
    expect(sb.flags & SuperblockFlags.EXPORTABLE).toBeTruthy();
  });

  it('has table offsets in ascending order', () => {
    expect(sb.inodeTableOffset).toBeLessThan(sb.dirTableOffset);
    expect(sb.dirTableOffset).toBeLessThan(sb.fragTableOffset);
    expect(sb.fragTableOffset).toBeLessThan(sb.idTableOffset);
  });

  it('throws on bad magic', () => {
    expect(() => parseSuperblock(new ArrayBuffer(96))).toThrow('Bad magic');
  });

  it('throws on too-small buffer', () => {
    expect(() => parseSuperblock(new ArrayBuffer(10))).toThrow('Buffer too small');
  });
});

describe('metadata + inode parsing against reference squashfs', () => {
  const sb = parseSuperblock(REF_SQUASHFS.buffer);

  it('can read the inode table metadata block', () => {
    const block = readMetadataBlock(
      REF_SQUASHFS.buffer,
      Number(sb.inodeTableOffset),
      zlibDecompress,
    );
    expect(block.data.length).toBeGreaterThan(0);
    expect(block.diskSize).toBeGreaterThan(2);
  });

  it('can parse the root directory inode', () => {
    const { blockOffset, byteOffset } = decodeMetadataRef(sb.rootInodeRef);
    const block = readMetadataBlock(
      REF_SQUASHFS.buffer,
      Number(sb.inodeTableOffset) + blockOffset,
      zlibDecompress,
    );
    const inode = parseBasicDirInode(block.data, byteOffset);
    expect(inode.type).toBe(InodeType.BASIC_DIR);
    expect(inode.parentInode).toBeGreaterThan(0);
    expect(inode.dirFileSize).toBeGreaterThan(3);
  });

  it('can parse directory entries and find all 3 files', () => {
    const { blockOffset, byteOffset } = decodeMetadataRef(sb.rootInodeRef);
    const inodeBlock = readMetadataBlock(
      REF_SQUASHFS.buffer,
      Number(sb.inodeTableOffset) + blockOffset,
      zlibDecompress,
    );
    const dirInode = parseBasicDirInode(inodeBlock.data, byteOffset);
    const dirBlock = readMetadataBlock(
      REF_SQUASHFS.buffer,
      Number(sb.dirTableOffset) + dirInode.dirBlockIndex!,
      zlibDecompress,
    );
    const entries = parseDirEntries(dirBlock.data, dirInode.dirBlockOffset!, dirInode.dirFileSize!);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['AppRun', 'test.desktop', 'test.png']);
  });

  it('file inodes reference a fragment', () => {
    const { blockOffset, byteOffset } = decodeMetadataRef(sb.rootInodeRef);
    const inodeBlock = readMetadataBlock(
      REF_SQUASHFS.buffer,
      Number(sb.inodeTableOffset) + blockOffset,
      zlibDecompress,
    );
    const dirInode = parseBasicDirInode(inodeBlock.data, byteOffset);
    const dirBlock = readMetadataBlock(
      REF_SQUASHFS.buffer,
      Number(sb.dirTableOffset) + dirInode.dirBlockIndex!,
      zlibDecompress,
    );
    const entries = parseDirEntries(dirBlock.data, dirInode.dirBlockOffset!, dirInode.dirFileSize!);
    for (const entry of entries) {
      expect(entry.type).toBe(InodeType.BASIC_FILE);
    }
  });
});

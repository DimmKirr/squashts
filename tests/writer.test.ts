import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  buildSquashfs,
  parseSuperblock,
  readMetadataBlock,
  decodeMetadataRef,
  parseBasicDirInode,
  parseDirEntries,
  Compressor,
  InodeType,
  SuperblockFlags,
  type SquashfsFile,
  type CompressFn,
  type DecompressFn,
} from '../src/index.js';

const encoder = new TextEncoder();

const TEST_FILES: SquashfsFile[] = [
  { name: 'AppRun', data: encoder.encode('#!/bin/bash\necho hello\n'), mode: 0o755 },
  { name: 'test.desktop', data: encoder.encode('[Desktop Entry]\nName=Test\nType=Application\nExec=AppRun\nIcon=test\n'), mode: 0o644 },
  { name: 'test.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]), mode: 0o644 },
];

const compress: CompressFn = (data) => new Uint8Array(deflateSync(data));
const decompress: DecompressFn = (data) => new Uint8Array(inflateSync(data));

describe('buildSquashfs', () => {
  const image = buildSquashfs(TEST_FILES, compress, { modTime: 0 });

  it('produces a buffer padded to 4096 bytes', () => {
    expect(image.length % 4096).toBe(0);
  });

  it('has a valid superblock magic', () => {
    const sb = parseSuperblock(image);
    expect(sb.magic).toBe(0x73717368);
  });

  it('has version 4.0', () => {
    const sb = parseSuperblock(image);
    expect(sb.versionMajor).toBe(4);
    expect(sb.versionMinor).toBe(0);
  });

  it('uses gzip compression', () => {
    const sb = parseSuperblock(image);
    expect(sb.compressor).toBe(Compressor.GZIP);
  });

  it('counts 4 inodes', () => {
    const sb = parseSuperblock(image);
    expect(sb.inodeCount).toBe(4);
  });

  it('counts 1 fragment', () => {
    const sb = parseSuperblock(image);
    expect(sb.fragCount).toBe(1);
  });

  it('has NO_XATTRS flag', () => {
    const sb = parseSuperblock(image);
    expect(sb.flags & SuperblockFlags.NO_XATTRS).toBeTruthy();
  });

  it('has a root dir inode', () => {
    const sb = parseSuperblock(image);
    const { blockOffset, byteOffset } = decodeMetadataRef(sb.rootInodeRef);
    const block = readMetadataBlock(
      image,
      Number(sb.inodeTableOffset) + blockOffset,
      decompress,
    );
    const inode = parseBasicDirInode(block.data, byteOffset);
    expect(inode.type).toBe(InodeType.BASIC_DIR);
    expect(inode.dirFileSize).toBeGreaterThan(3);
  });

  it('directory lists all 3 files alphabetically', () => {
    const sb = parseSuperblock(image);
    const { blockOffset, byteOffset } = decodeMetadataRef(sb.rootInodeRef);
    const inodeBlock = readMetadataBlock(
      image,
      Number(sb.inodeTableOffset) + blockOffset,
      decompress,
    );
    const dirInode = parseBasicDirInode(inodeBlock.data, byteOffset);
    const dirBlock = readMetadataBlock(
      image,
      Number(sb.dirTableOffset) + dirInode.dirBlockIndex!,
      decompress,
    );
    const entries = parseDirEntries(dirBlock.data, dirInode.dirBlockOffset!, dirInode.dirFileSize!);
    const names = entries.map((e) => e.name);
    expect(names).toEqual(['AppRun', 'test.desktop', 'test.png']);
  });
});

describe('unsquashfs verification', () => {
  function findUnsquashfs(): string | null {
    const candidates = [
      join(process.env.HOME!, '.nix-profile', 'bin', 'unsquashfs'),
      '/usr/bin/unsquashfs',
      'unsquashfs',
    ];
    for (const bin of candidates) {
      try {
        execSync(`${bin} -help`, { stdio: 'pipe' });
        return bin;
      } catch (err: any) {
        if (err.status !== 127 && (err.stdout?.length > 0 || err.stderr?.length > 0)) return bin;
      }
    }
    return null;
  }

  it('unsquashfs extracts all files byte-for-byte', () => {
    const unsquashfs = findUnsquashfs();
    if (!unsquashfs) {
      console.warn('unsquashfs not available, skipping');
      return;
    }

    const image = buildSquashfs(TEST_FILES, compress, { modTime: 0 });
    const tmpDir = mkdtempSync('/tmp/squashfs-test-');
    const sqfsPath = join(tmpDir, 'test.squashfs');
    const extractDir = join(tmpDir, 'extracted');

    try {
      writeFileSync(sqfsPath, image);
      execSync(`${unsquashfs} -d ${extractDir} -no-xattrs ${sqfsPath}`, { stdio: 'pipe' });

      const extracted = readdirSync(extractDir).sort();
      expect(extracted).toEqual(['AppRun', 'test.desktop', 'test.png']);

      for (const f of TEST_FILES) {
        const actual = readFileSync(join(extractDir, f.name));
        expect(Buffer.from(actual).equals(Buffer.from(f.data))).toBe(true);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

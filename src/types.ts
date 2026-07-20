export const SQUASHFS_MAGIC = 0x73717368; // "hsqs"
export const SUPERBLOCK_SIZE = 96;
export const METADATA_BLOCK_SIZE = 8192;
export const NO_XATTR = 0xffff_ffff_ffff_ffffn;
export const NO_FRAGMENT = 0xffff_ffff;
export const BLOCK_UNCOMPRESSED_FLAG = 1 << 24;

export const Compressor = {
  GZIP: 1,
  LZMA: 2,
  LZO: 3,
  XZ: 4,
  LZ4: 5,
  ZSTD: 6,
} as const;
export type CompressorId = (typeof Compressor)[keyof typeof Compressor];

export const SuperblockFlags = {
  UNCOMPRESSED_INODES: 0x0001,
  UNCOMPRESSED_DATA: 0x0002,
  UNCOMPRESSED_FRAGMENTS: 0x0008,
  NO_FRAGMENTS: 0x0010,
  ALWAYS_FRAGMENTS: 0x0020,
  DUPLICATES: 0x0040,
  EXPORTABLE: 0x0080,
  UNCOMPRESSED_XATTRS: 0x0100,
  NO_XATTRS: 0x0200,
  COMPRESSOR_OPTIONS: 0x0400,
  UNCOMPRESSED_IDS: 0x0800,
} as const;

export const InodeType = {
  BASIC_DIR: 1,
  BASIC_FILE: 2,
  BASIC_SYMLINK: 3,
  BASIC_BLOCK_DEV: 4,
  BASIC_CHAR_DEV: 5,
  BASIC_FIFO: 6,
  BASIC_SOCKET: 7,
  EXT_DIR: 8,
  EXT_FILE: 9,
} as const;

export interface Superblock {
  magic: number;
  inodeCount: number;
  modTime: number;
  blockSize: number;
  fragCount: number;
  compressor: CompressorId;
  blockLog: number;
  flags: number;
  idCount: number;
  versionMajor: number;
  versionMinor: number;
  rootInodeRef: bigint;
  bytesUsed: bigint;
  idTableOffset: bigint;
  xattrTableOffset: bigint;
  inodeTableOffset: bigint;
  dirTableOffset: bigint;
  fragTableOffset: bigint;
  exportTableOffset: bigint;
}

export interface SquashfsFile {
  name: string;
  data: Uint8Array;
  mode: number;
}

export type BinaryInput = ArrayBuffer | Uint8Array;
export type CompressFn = (data: Uint8Array) => Uint8Array;
export type DecompressFn = (data: Uint8Array) => Uint8Array;

export {
  SQUASHFS_MAGIC,
  SUPERBLOCK_SIZE,
  METADATA_BLOCK_SIZE,
  NO_XATTR,
  NO_FRAGMENT,
  BLOCK_UNCOMPRESSED_FLAG,
  Compressor,
  SuperblockFlags,
  InodeType,
  type CompressorId,
  type Superblock,
  type SquashfsFile,
  type CompressFn,
  type DecompressFn,
} from './types.js';

export {
  parseSuperblock,
  readMetadataBlock,
  decodeMetadataRef,
  parseInodeHeader,
  parseBasicFileInode,
  parseBasicDirInode,
  parseDirEntries,
  type ParsedInode,
  type DirEntry,
} from './parser.js';

export { buildSquashfs } from './writer.js';

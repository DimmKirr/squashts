# squashts

Pure TypeScript squashfs 4.0 reader/writer. Zero runtime dependencies.

Runs anywhere JavaScript runs: Node.js, Cloudflare Workers, Deno, browsers.

## Install

```sh
npm install @dimmkirr/squashts
```

## Usage

### Write a squashfs image

```typescript
import { buildSquashfs, type SquashfsFile } from '@dimmkirr/squashts';
import { deflateSync } from 'node:zlib';

const files: SquashfsFile[] = [
  { name: 'AppRun', data: new TextEncoder().encode('#!/bin/bash\necho hello\n'), mode: 0o755 },
  { name: 'app.desktop', data: new TextEncoder().encode('[Desktop Entry]\nName=App\n'), mode: 0o644 },
];

const image = buildSquashfs(files, (data) => new Uint8Array(deflateSync(data)));
// image is a Uint8Array containing a valid squashfs 4.0 archive
```

### Parse a squashfs image

```typescript
import { parseSuperblock, readMetadataBlock, decodeMetadataRef, parseBasicDirInode, parseDirEntries } from '@dimmkirr/squashts';
import { inflateSync } from 'node:zlib';

const decompress = (data: Uint8Array) => new Uint8Array(inflateSync(data));
const buf = fs.readFileSync('image.squashfs').buffer;

const sb = parseSuperblock(buf);
const { blockOffset, byteOffset } = decodeMetadataRef(sb.rootInodeRef);
const block = readMetadataBlock(buf, Number(sb.inodeTableOffset) + blockOffset, decompress);
const root = parseBasicDirInode(block.data, byteOffset);
```

## Bring your own compression

The library has zero runtime dependencies. You provide the compress/decompress functions:

- **Node.js**: `node:zlib` `deflateSync` / `inflateSync`
- **Cloudflare Workers**: `CompressionStream` / `DecompressionStream` (wrap in sync adapter)
- **Browser**: `CompressionStream` API or a WASM deflate library

Squashfs "gzip" compression uses raw deflate (RFC 1951), not gzip-wrapped data.

## Scope

Currently supports:
- Flat directory (single root, no subdirectories)
- All files stored in fragments (each file < 128 KiB)
- Gzip (deflate) compression
- Basic file and directory inodes
- Single uid/gid (root)

This covers the AppImage use case (AppRun + .desktop + icon) and similar small archives.

## License

MIT

/**
 * Pack files `packs/r<px>_<py>.ffp` (Map Generation `src/ffworld/pack.ts`, chunk-format-spec.md §1.3): a 64 byte
 * header, a table of `packChunks²` 32 byte entries (row by row, `ly * packChunks + lx`), then the chunk records.
 *
 * Header:  0 u32 magic "FFWP"  4 u16 version  6 u16 headerBytes  8 u16 px  10 u16 py  12 u16 chunkSize
 *          14 u16 packChunks  16 u16 tileLayerCount  18 u16 flags  20 u32 packRev  24 u64 generationId  32 u64 packHash
 * Entry:   0 u32 offset  4 u32 storedLength  8 u32 rawLength  12 u8 codec  14 u16 layerMask  16 u64 contentHash
 *          24 u32 chunkRev
 */
import { CODEC_NONE, CODEC_ZLIB, FORMAT_VERSION } from "./chunk";
import { WorldError } from "./host";
import { type U64, hex64, readU64, writeU64, xxh64 } from "./xxh64";

export const PACK_MAGIC = 0x50574646;
export const PACK_HEADER_BYTES = 64;
export const TABLE_ENTRY_BYTES = 32;
/** contentHash of an empty chunk: xxh64 of the empty payload. */
export const EMPTY_HASH: U64 = xxh64(new Uint8Array(0));

export interface PackHeader {
    packX: number;
    packY: number;
    chunkSize: number;
    packChunks: number;
    tileLayerCount: number;
    flags: number;
    packRev: number;
    generationId: string;
    packHash: string;
}

export interface PackEntry {
    offset: number;
    storedLength: number;
    rawLength: number;
    codec: number;
    layerMask: number;
    contentHash: U64;
    chunkRev: number;
}

/** A chunk ready to be placed in a pack. Records copied from an existing pack keep their stored bytes. */
export interface ChunkRecord {
    stored: Uint8Array;
    rawLength: number;
    codec: number;
    layerMask: number;
    contentHash: U64;
    chunkRev: number;
}

export const packFileName = (px: number, py: number): string => `packs/r${px}_${py}.ffp`;
export const packTableBytes = (packChunks: number): number => PACK_HEADER_BYTES + packChunks * packChunks * TABLE_ENTRY_BYTES;

/** Parse and check a pack header. */
export function readPackHeader(bytes: Uint8Array): PackHeader {
    if (bytes.byteLength < PACK_HEADER_BYTES) throw new WorldError("truncated pack header");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== PACK_MAGIC) throw new WorldError("bad pack magic (expected FFWP)");
    if (dv.getUint16(4, true) !== FORMAT_VERSION) throw new WorldError(`unsupported pack format version ${dv.getUint16(4, true)}`);
    if (dv.getUint16(6, true) !== PACK_HEADER_BYTES) throw new WorldError(`pack header size ${dv.getUint16(6, true)} != ${PACK_HEADER_BYTES}`);
    const h: PackHeader = {
        packX: dv.getUint16(8, true),
        packY: dv.getUint16(10, true),
        chunkSize: dv.getUint16(12, true),
        packChunks: dv.getUint16(14, true),
        tileLayerCount: dv.getUint16(16, true),
        flags: dv.getUint16(18, true),
        packRev: dv.getUint32(20, true),
        generationId: hex64(readU64(dv, 24)),
        packHash: hex64(readU64(dv, 32)),
    };
    if (h.packChunks < 1 || h.chunkSize < 8) throw new WorldError("invalid pack geometry");
    return h;
}

/** Parse the chunk table. `bytes` holds at least the header and the table; `fileLength` bounds the records. */
export function readPackTable(bytes: Uint8Array, packChunks: number, fileLength: number): PackEntry[] {
    const n = packChunks * packChunks;
    const tableEnd = packTableBytes(packChunks);
    if (bytes.byteLength < tableEnd) throw new WorldError("truncated pack table");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries: PackEntry[] = [];
    for (let i = 0; i < n; i++) {
        const e = PACK_HEADER_BYTES + i * TABLE_ENTRY_BYTES;
        const entry: PackEntry = {
            offset: dv.getUint32(e, true),
            storedLength: dv.getUint32(e + 4, true),
            rawLength: dv.getUint32(e + 8, true),
            codec: bytes[e + 12]!,
            layerMask: dv.getUint16(e + 14, true),
            contentHash: readU64(dv, e + 16),
            chunkRev: dv.getUint32(e + 24, true),
        };
        const bad = entry.offset === 0
            ? entry.storedLength !== 0 || entry.layerMask !== 0 || entry.rawLength !== 0
            : entry.offset < tableEnd || entry.offset + entry.storedLength > fileLength;
        if (bad) throw new WorldError(`invalid pack table entry ${i}`);
        if (entry.codec !== CODEC_NONE && entry.codec !== CODEC_ZLIB) throw new WorldError(`unsupported codec ${entry.codec} in pack table entry ${i}`);
        entries.push(entry);
    }
    return entries;
}

/** packHash: xxh64 over the table's contentHash fields (u64 LE each) in table order. */
export function computePackHash(hashes: U64[]): U64 {
    const b = new Uint8Array(hashes.length * 8);
    const dv = new DataView(b.buffer);
    hashes.forEach((h, i) => writeU64(dv, i * 8, h));
    return xxh64(b);
}

/** Copy table entry `i` of an existing pack as is. */
export function recordFromEntry(bytes: Uint8Array, entry: PackEntry): ChunkRecord {
    return {
        stored: entry.offset === 0 ? new Uint8Array(0) : bytes.subarray(entry.offset, entry.offset + entry.storedLength),
        rawLength: entry.rawLength,
        codec: entry.codec,
        layerMask: entry.layerMask,
        contentHash: entry.contentHash,
        chunkRev: entry.chunkRev,
    };
}

/**
 * Assemble a pack file. The header's position, geometry, flags and generationId come from `header`; packRev and
 * packHash are computed from the records. Records are placed back to back in table order.
 */
export function buildPack(header: PackHeader, generationId: U64, records: ChunkRecord[]): { bytes: Uint8Array; packHash: string; packRev: number } {
    const n = header.packChunks * header.packChunks;
    if (records.length !== n) throw new WorldError(`pack needs ${n} records, got ${records.length}`);
    let total = packTableBytes(header.packChunks);
    for (const r of records) total += r.stored.byteLength;
    if (total > 0xffffffff) throw new WorldError("pack exceeds 4 GiB");
    const bytes = new Uint8Array(total);
    const dv = new DataView(bytes.buffer);
    const packHash = computePackHash(records.map(r => r.contentHash));
    let packRev = 0;
    for (const r of records) if (r.chunkRev > packRev) packRev = r.chunkRev;
    dv.setUint32(0, PACK_MAGIC, true);
    dv.setUint16(4, FORMAT_VERSION, true);
    dv.setUint16(6, PACK_HEADER_BYTES, true);
    dv.setUint16(8, header.packX, true);
    dv.setUint16(10, header.packY, true);
    dv.setUint16(12, header.chunkSize, true);
    dv.setUint16(14, header.packChunks, true);
    dv.setUint16(16, header.tileLayerCount, true);
    dv.setUint16(18, header.flags, true);
    dv.setUint32(20, packRev, true);
    writeU64(dv, 24, generationId);
    writeU64(dv, 32, packHash);
    let off = packTableBytes(header.packChunks);
    records.forEach((r, i) => {
        const e = PACK_HEADER_BYTES + i * TABLE_ENTRY_BYTES;
        const empty = r.stored.byteLength === 0;
        if (empty && r.layerMask !== 0) throw new WorldError("record with layers but no bytes");
        dv.setUint32(e, empty ? 0 : off, true);
        dv.setUint32(e + 4, r.stored.byteLength, true);
        dv.setUint32(e + 8, r.rawLength, true);
        bytes[e + 12] = r.codec;
        dv.setUint16(e + 14, r.layerMask, true);
        writeU64(dv, e + 16, r.contentHash);
        dv.setUint32(e + 24, r.chunkRev >>> 0, true);
        if (!empty) {
            bytes.set(r.stored, off);
            off += r.stored.byteLength;
        }
    });
    return { bytes, packHash: hex64(packHash), packRev };
}

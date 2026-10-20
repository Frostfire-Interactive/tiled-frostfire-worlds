/**
 * Chunk record payload of the ffworld v1 format (Map Generation `src/ffworld/chunk.ts`, chunk-format-spec.md §1.4).
 *
 * A raw payload holds, for each tile layer i in `tileIndex` order whose `layerMask` bit is set, an 8 byte block
 * header followed by the block data:
 *
 *   +0 u8 encoding (1 FILL, 2 BIT, 3 U16, 4 U32)  +1 u8 0  +2 u16 0  +4 u32 value  +8 data
 *
 * Values are raw Tiled gids including the flip flags. All integers are little endian. The encoder rule must match
 * the generator exactly: the engine and asset server verify that payloads are canonical.
 */
import { WorldError } from "./host";

export const FORMAT_VERSION = 1;
export const ENC_FILL = 1;
export const ENC_BIT = 2;
export const ENC_U16 = 3;
export const ENC_U32 = 4;
export const CODEC_NONE = 0;
export const CODEC_ZLIB = 1;
export const BLOCK_HEADER = 8;
/** Max tile layers per world: `layerMask` is a u16. */
export const MAX_TILE_LAYERS = 16;

/** True on little endian machines, where typed array views read the format's byte order directly. */
export const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Encoding the encoder rule picks for one layer block (0 = the block is omitted). */
export function chooseEncoding(tiles: Uint32Array): { encoding: number; value: number } {
    const n = tiles.length;
    const first = tiles[0]!;
    let other = 0;
    let bitOk = true;
    let allEqual = true;
    let max = 0;
    let any = false;
    for (let i = 0; i < n; i++) {
        const v = tiles[i]!;
        if (v !== first) allEqual = false;
        if (v !== 0) {
            any = true;
            if (v > max) max = v;
            if (other === 0) other = v;
            else if (v !== other) bitOk = false;
        }
    }
    if (!any) return { encoding: 0, value: 0 };
    if (allEqual) return { encoding: ENC_FILL, value: first };
    if (bitOk) return { encoding: ENC_BIT, value: other };
    if (max <= 0xffff) return { encoding: ENC_U16, value: 0 };
    return { encoding: ENC_U32, value: 0 };
}

const blockDataBytes = (encoding: number, area: number): number =>
    encoding === ENC_FILL ? 0 : encoding === ENC_BIT ? area >>> 3 : encoding === ENC_U16 ? area * 2 : area * 4;

/**
 * Encode one chunk. `layers[i]` holds the `chunkSize²` tiles of tile layer i, row by row. The same tiles always
 * give the same bytes. An all-zero chunk gives an empty payload and layer mask 0.
 */
export function encodeChunkPayload(layers: Uint32Array[], chunkSize: number): { raw: Uint8Array; layerMask: number } {
    const area = chunkSize * chunkSize;
    if (layers.length > MAX_TILE_LAYERS) throw new WorldError(`${layers.length} tile layers (max ${MAX_TILE_LAYERS})`);
    const picks = layers.map(l => {
        if (l.length !== area) throw new WorldError(`layer block has ${l.length} tiles, expected ${area}`);
        return chooseEncoding(l);
    });
    let size = 0;
    let layerMask = 0;
    picks.forEach((p, i) => {
        if (p.encoding === 0) return;
        layerMask |= 1 << i;
        size += BLOCK_HEADER + blockDataBytes(p.encoding, area);
    });
    const raw = new Uint8Array(size);
    const dv = new DataView(raw.buffer);
    let o = 0;
    for (let i = 0; i < layers.length; i++) {
        const { encoding, value } = picks[i]!;
        if (encoding === 0) continue;
        const t = layers[i]!;
        raw[o] = encoding;
        dv.setUint32(o + 4, value, true);
        o += BLOCK_HEADER;
        if (encoding === ENC_BIT) {
            for (let k = 0; k < area; k++) if (t[k] !== 0) raw[o + (k >>> 3)]! |= 1 << (k & 7);
            o += area >>> 3;
        } else if (encoding === ENC_U16) {
            // Blocks start on 8 byte boundaries, so typed array views line up
            if (LITTLE_ENDIAN) new Uint16Array(raw.buffer, o, area).set(t);
            else for (let k = 0; k < area; k++) dv.setUint16(o + k * 2, t[k]!, true);
            o += area * 2;
        } else if (encoding === ENC_U32) {
            if (LITTLE_ENDIAN) new Uint32Array(raw.buffer, o, area).set(t);
            else for (let k = 0; k < area; k++) dv.setUint32(o + k * 4, t[k]!, true);
            o += area * 4;
        }
    }
    return { raw, layerMask };
}

/**
 * Decode a raw payload into `layerCount` arrays of `chunkSize²` tiles (absent layers are all zero).
 * Rejects unknown encodings, non-zero reserved bytes, truncation and trailing bytes.
 */
export function decodeChunkPayload(raw: Uint8Array, layerMask: number, layerCount: number, chunkSize: number): Uint32Array[] {
    const area = chunkSize * chunkSize;
    if (layerMask >>> layerCount !== 0) throw new WorldError(`layerMask 0x${layerMask.toString(16)} names a layer >= ${layerCount}`);
    const out: Uint32Array[] = [];
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let o = 0;
    for (let i = 0; i < layerCount; i++) {
        const tiles = new Uint32Array(area);
        out.push(tiles);
        if (!(layerMask & (1 << i))) continue;
        if (o + BLOCK_HEADER > raw.byteLength) throw new WorldError(`truncated payload: block header of layer ${i}`);
        const encoding = raw[o]!;
        if (raw[o + 1] !== 0 || dv.getUint16(o + 2, true) !== 0) throw new WorldError(`non-zero reserved bytes in block of layer ${i}`);
        const value = dv.getUint32(o + 4, true);
        o += BLOCK_HEADER;
        if (encoding < ENC_FILL || encoding > ENC_U32) throw new WorldError(`unknown encoding ${encoding} in layer ${i}`);
        const need = blockDataBytes(encoding, area);
        if (o + need > raw.byteLength) throw new WorldError(`truncated payload: data of layer ${i}`);
        if (encoding === ENC_FILL) tiles.fill(value);
        else if (encoding === ENC_BIT) {
            for (let k = 0; k < area; k++) if ((raw[o + (k >>> 3)]! >>> (k & 7)) & 1) tiles[k] = value;
        } else if (encoding === ENC_U16) {
            if (LITTLE_ENDIAN && ((raw.byteOffset + o) & 1) === 0) tiles.set(new Uint16Array(raw.buffer, raw.byteOffset + o, area));
            else for (let k = 0; k < area; k++) tiles[k] = dv.getUint16(o + k * 2, true);
        } else {
            if (LITTLE_ENDIAN && ((raw.byteOffset + o) & 3) === 0) tiles.set(new Uint32Array(raw.buffer, raw.byteOffset + o, area));
            else for (let k = 0; k < area; k++) tiles[k] = dv.getUint32(o + k * 4, true);
        }
        o += need;
    }
    if (o !== raw.byteLength) throw new WorldError(`${raw.byteLength - o} trailing bytes after the last layer block`);
    return out;
}

/** Byte-wise equality of two arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
}

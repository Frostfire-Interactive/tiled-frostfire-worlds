/**
 * World bitset files `collision.bits` / `nopvp.bits` (Map Generation `src/ffworld/bitset.ts`, spec §1.5).
 *
 *   0 "FFWB"  4 u16 version 1  6 u16 headerBytes 32  8 u16 chunkSize  10 u16 chunksX  12 u16 chunksY
 *   14 u16 role (1 collision, 2 nopvp)  16 u64 bodyHash = xxh64(body)  24 8 reserved  32 body
 *
 * Body: one block of chunkSize²/8 bytes per chunk, in the order `cy * chunksX + cx`. Inside a block, bit k
 * (k = ly * chunkSize + lx) is bit k & 7 of byte k >> 3.
 */
import { FORMAT_VERSION } from "./chunk";
import { WorldError } from "./host";
import { hex64, writeU64, xxh64 } from "./xxh64";

export const BITS_MAGIC = 0x42574646;
export const BITS_HEADER_BYTES = 32;
export const ROLE_COLLISION = 1;
export const ROLE_NOPVP = 2;

export class WorldBitset {
    readonly blockBytes: number;

    constructor(readonly bytes: Uint8Array, readonly chunkSize: number, readonly chunksX: number, readonly chunksY: number, readonly role: number) {
        this.blockBytes = (chunkSize * chunkSize) >>> 3;
    }

    /** Parse a bitset file and check it against the world's geometry. */
    static parse(bytes: Uint8Array, chunkSize: number, chunksX: number, chunksY: number, role: number): WorldBitset {
        if (bytes.byteLength < BITS_HEADER_BYTES) throw new WorldError("truncated bitset header");
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (dv.getUint32(0, true) !== BITS_MAGIC) throw new WorldError("bad bitset magic (expected FFWB)");
        if (dv.getUint16(4, true) !== FORMAT_VERSION) throw new WorldError(`unsupported bitset format version ${dv.getUint16(4, true)}`);
        if (dv.getUint16(6, true) !== BITS_HEADER_BYTES) throw new WorldError("bad bitset header size");
        if (dv.getUint16(8, true) !== chunkSize || dv.getUint16(10, true) !== chunksX || dv.getUint16(12, true) !== chunksY)
            throw new WorldError("bitset size disagrees with the manifest");
        if (dv.getUint16(14, true) !== role) throw new WorldError(`bitset has role ${dv.getUint16(14, true)}, expected ${role}`);
        const b = new WorldBitset(bytes, chunkSize, chunksX, chunksY, role);
        const size = BITS_HEADER_BYTES + chunksX * chunksY * b.blockBytes;
        if (bytes.byteLength !== size) throw new WorldError(`bitset file is ${bytes.byteLength} bytes, expected ${size}`);
        return b;
    }

    /** Overwrite one chunk's block. Call {@link seal} after the last patch. */
    patchChunk(cx: number, cy: number, block: Uint8Array): void {
        if (block.byteLength !== this.blockBytes) throw new WorldError(`block is ${block.byteLength} bytes, expected ${this.blockBytes}`);
        if (cx < 0 || cy < 0 || cx >= this.chunksX || cy >= this.chunksY) throw new WorldError(`chunk ${cx},${cy} outside the bitset`);
        this.bytes.set(block, BITS_HEADER_BYTES + (cy * this.chunksX + cx) * this.blockBytes);
    }

    /** Recompute the body hash, write it into the header and return it as hex. */
    seal(): string {
        const h = xxh64(this.bytes.subarray(BITS_HEADER_BYTES));
        writeU64(new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength), 16, h);
        return hex64(h);
    }
}

/** One chunk's bitset block: bit k is set when any of `layers` is non-zero at tile k. */
export function roleBlock(layers: Uint32Array[], chunkSize: number): Uint8Array {
    const area = chunkSize * chunkSize;
    const b = new Uint8Array(area >>> 3);
    for (const l of layers) for (let k = 0; k < area; k++) if (l[k] !== 0) b[k >>> 3]! |= 1 << (k & 7);
    return b;
}

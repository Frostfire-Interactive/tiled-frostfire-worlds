/**
 * xxHash64 with seed 0, as the ffworld format uses it (contentHash, packHash, bitset bodyHash).
 *
 * Tiled runs extensions in Qt's QJSEngine, which has no BigInt. Every 64 bit value here is therefore a pair of
 * unsigned 32 bit numbers (hi, lo). Helpers return their result through the module variables `RH` / `RL` so the
 * hot loop does not allocate.
 */

/** An unsigned 64 bit value as two unsigned 32 bit halves. */
export interface U64 {
    hi: number;
    lo: number;
}

let RH = 0;
let RL = 0;

const P1H = 0x9e3779b1, P1L = 0x85ebca87;
const P2H = 0xc2b2ae3d, P2L = 0x27d4eb4f;
const P3H = 0x165667b1, P3L = 0x9e3779f9;
const P4H = 0x85ebca77, P4L = 0xc2b2ae63;
const P5H = 0x27d4eb2f, P5L = 0x165667c5;

// Low 64 bits of a * b
function mul(aH: number, aL: number, bH: number, bL: number): void {
    const a0 = aL & 0xffff, a1 = aL >>> 16;
    const b0 = bL & 0xffff, b1 = bL >>> 16;
    const p00 = a0 * b0;
    const p01 = a0 * b1;
    const p10 = a1 * b0;
    const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
    RL = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
    const hi = a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16);
    RH = (hi + Math.imul(aH, bL) + Math.imul(aL, bH)) >>> 0;
}

function add(aH: number, aL: number, bH: number, bL: number): void {
    const lo = aL + bL;
    RL = lo >>> 0;
    RH = (aH + bH + (lo > 0xffffffff ? 1 : 0)) >>> 0;
}

function rotl(h: number, l: number, r: number): void {
    if (r === 32) {
        RH = l;
        RL = h;
    } else if (r < 32) {
        RH = ((h << r) | (l >>> (32 - r))) >>> 0;
        RL = ((l << r) | (h >>> (32 - r))) >>> 0;
    } else {
        const s = r - 32;
        RH = ((l << s) | (h >>> (32 - s))) >>> 0;
        RL = ((h << s) | (l >>> (32 - s))) >>> 0;
    }
}

// acc = rotl(acc + input * P2, 31) * P1
function round(accH: number, accL: number, inH: number, inL: number): void {
    mul(inH, inL, P2H, P2L);
    add(accH, accL, RH, RL);
    rotl(RH, RL, 31);
    mul(RH, RL, P1H, P1L);
}

// acc = (acc ^ round(0, val)) * P1 + P4
function merge(accH: number, accL: number, vH: number, vL: number): void {
    round(0, 0, vH, vL);
    const xh = (accH ^ RH) >>> 0, xl = (accL ^ RL) >>> 0;
    mul(xh, xl, P1H, P1L);
    add(RH, RL, P4H, P4L);
}

const u32 = (b: Uint8Array, p: number): number => (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;

/** xxHash64 (seed 0) of `data`. */
export function xxh64(data: Uint8Array): U64 {
    const len = data.byteLength;
    let p = 0;
    let hH: number, hL: number;
    if (len >= 32) {
        add(P1H, P1L, P2H, P2L);
        let v1H = RH, v1L = RL;
        let v2H = P2H, v2L = P2L;
        let v3H = 0, v3L = 0;
        // 0 - P1
        add(~P1H >>> 0, ~P1L >>> 0, 0, 1);
        let v4H = RH, v4L = RL;
        const limit = len - 32;
        while (p <= limit) {
            round(v1H, v1L, u32(data, p + 4), u32(data, p));
            v1H = RH; v1L = RL;
            round(v2H, v2L, u32(data, p + 12), u32(data, p + 8));
            v2H = RH; v2L = RL;
            round(v3H, v3L, u32(data, p + 20), u32(data, p + 16));
            v3H = RH; v3L = RL;
            round(v4H, v4L, u32(data, p + 28), u32(data, p + 24));
            v4H = RH; v4L = RL;
            p += 32;
        }
        rotl(v1H, v1L, 1);
        hH = RH; hL = RL;
        rotl(v2H, v2L, 7);
        add(hH, hL, RH, RL);
        hH = RH; hL = RL;
        rotl(v3H, v3L, 12);
        add(hH, hL, RH, RL);
        hH = RH; hL = RL;
        rotl(v4H, v4L, 18);
        add(hH, hL, RH, RL);
        merge(RH, RL, v1H, v1L);
        merge(RH, RL, v2H, v2L);
        merge(RH, RL, v3H, v3L);
        merge(RH, RL, v4H, v4L);
        hH = RH; hL = RL;
    } else {
        hH = P5H; hL = P5L;
    }
    add(hH, hL, Math.floor(len / 0x100000000) >>> 0, len >>> 0);
    hH = RH; hL = RL;
    while (p + 8 <= len) {
        round(0, 0, u32(data, p + 4), u32(data, p));
        rotl((hH ^ RH) >>> 0, (hL ^ RL) >>> 0, 27);
        mul(RH, RL, P1H, P1L);
        add(RH, RL, P4H, P4L);
        hH = RH; hL = RL;
        p += 8;
    }
    if (p + 4 <= len) {
        mul(0, u32(data, p), P1H, P1L);
        rotl((hH ^ RH) >>> 0, (hL ^ RL) >>> 0, 23);
        mul(RH, RL, P2H, P2L);
        add(RH, RL, P3H, P3L);
        hH = RH; hL = RL;
        p += 4;
    }
    while (p < len) {
        mul(0, data[p]!, P5H, P5L);
        rotl((hH ^ RH) >>> 0, (hL ^ RL) >>> 0, 11);
        mul(RH, RL, P1H, P1L);
        hH = RH; hL = RL;
        p++;
    }
    // Avalanche
    hL = (hL ^ (hH >>> 1)) >>> 0; // h ^= h >> 33
    mul(hH, hL, P2H, P2L);
    hH = RH; hL = RL;
    hL = (hL ^ ((hL >>> 29) | (hH << 3))) >>> 0; // h ^= h >> 29
    hH = (hH ^ (hH >>> 29)) >>> 0;
    mul(hH, hL, P3H, P3L);
    hH = RH; hL = RL;
    hL = (hL ^ hH) >>> 0; // h ^= h >> 32
    return { hi: hH, lo: hL };
}

/** 16 lowercase hex digits: the manifest's text form of a u64. */
export function hex64(v: U64): string {
    const h = v.hi.toString(16), l = v.lo.toString(16);
    return "00000000".slice(h.length) + h + "00000000".slice(l.length) + l;
}

/** Inverse of {@link hex64}. */
export function parseHex64(s: string): U64 {
    if (typeof s !== "string" || !/^[0-9a-f]{16}$/.test(s)) throw new Error(`expected 16 lowercase hex digits, got ${JSON.stringify(s)}`);
    return { hi: parseInt(s.slice(0, 8), 16) >>> 0, lo: parseInt(s.slice(8), 16) >>> 0 };
}

export const u64Equal = (a: U64, b: U64): boolean => a.hi === b.hi && a.lo === b.lo;

/** Read a little endian u64 at `offset`. */
export function readU64(dv: DataView, offset: number): U64 {
    return { lo: dv.getUint32(offset, true), hi: dv.getUint32(offset + 4, true) };
}

/** Write a little endian u64 at `offset`. */
export function writeU64(dv: DataView, offset: number, v: U64): void {
    dv.setUint32(offset, v.lo, true);
    dv.setUint32(offset + 4, v.hi, true);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import type { Host } from "../src/lib/host";
import { decodeChunkPayload } from "../src/lib/chunk";
import { BITS_HEADER_BYTES, roleBlock } from "../src/lib/bitset";
import { type Manifest, parseManifest, tileLayers } from "../src/lib/manifest";
import { computePackHash, readPackHeader, readPackTable } from "../src/lib/pack";
import { hex64, xxh64 } from "../src/lib/xxh64";

export const FIXTURE = path.join(import.meta.dir, "fixtures", "world");
export const FIXTURE_WORLD = path.join(FIXTURE, "fixture.world");
export const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE, "expected.json"), "utf8"));

/** {@link Host} on node:fs and node:zlib, recording every file written. */
export function nodeHost(): Host & { written: string[] } {
    const written: string[] = [];
    return {
        written,
        exists: p => fs.existsSync(p),
        readText: p => fs.readFileSync(p, "utf8"),
        writeText(p, text) {
            written.push(p);
            fs.writeFileSync(p, text);
        },
        readBytes: p => new Uint8Array(fs.readFileSync(p)),
        readRanges(p, ranges) {
            const fd = fs.openSync(p, "r");
            try {
                return ranges.map(r => {
                    const b = Buffer.alloc(r.length);
                    const n = fs.readSync(fd, b, 0, r.length, r.offset);
                    return new Uint8Array(b.subarray(0, n));
                });
            } finally {
                fs.closeSync(fd);
            }
        },
        writeBytes(p, data) {
            written.push(p);
            fs.writeFileSync(p, data);
        },
        remove: p => fs.rmSync(p, { force: true }),
        deflate: d => new Uint8Array(zlib.deflateSync(d, { level: 6 })),
        decompress: (d, m) => new Uint8Array(m === "zlib" ? zlib.inflateSync(d) : m === "gzip" ? zlib.gunzipSync(d) : (zlib as any).zstdDecompressSync(d)),
        base64Encode: d => Buffer.from(d).toString("base64"),
        base64Decode: t => new Uint8Array(Buffer.from(t, "base64")),
    };
}

/** A fresh copy of the fixture world in a temp directory. */
export function copyFixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "world-"));
    const world = path.join(dir, "fixture.world");
    fs.cpSync(FIXTURE_WORLD, world, { recursive: true });
    return world.replace(/\\/g, "/");
}

export const readWorldManifest = (world: string): Manifest => parseManifest(fs.readFileSync(path.join(world, "manifest.json"), "utf8"));

/** Every tile of every layer of a world, decoded from its packs. */
export function decodeAll(host: Host, world: string): { manifest: Manifest; tiles: Uint32Array[]; revs: Uint32Array } {
    const m = readWorldManifest(world);
    const cs = m.chunkSize;
    const n = tileLayers(m).length;
    const tiles = Array.from({ length: n }, () => new Uint32Array(m.width * m.height));
    const revs = new Uint32Array(m.chunksX * m.chunksY);
    for (const p of m.packs) {
        const bytes = host.readBytes(path.join(world, p.file));
        const entries = readPackTable(bytes, m.packChunks, bytes.byteLength);
        entries.forEach((e, i) => {
            const cx = p.px * m.packChunks + (i % m.packChunks);
            const cy = p.py * m.packChunks + Math.floor(i / m.packChunks);
            if (cx >= m.chunksX || cy >= m.chunksY) return;
            revs[cy * m.chunksX + cx] = e.chunkRev;
            if (!e.offset) return;
            const raw = host.decompress(bytes.subarray(e.offset, e.offset + e.storedLength), "zlib");
            const layers = decodeChunkPayload(raw, e.layerMask, n, cs);
            for (let l = 0; l < n; l++)
                for (let ly = 0; ly < cs; ly++) tiles[l]!.set(layers[l]!.subarray(ly * cs, ly * cs + cs), (cy * cs + ly) * m.width + cx * cs);
        });
    }
    return { manifest: m, tiles, revs };
}

/**
 * Check a world the way the engine and asset server do: pack headers and hashes against the manifest and the
 * table, every contentHash against its payload, and both bitsets against the collision / no-PvP layers.
 */
export function verifyWorld(host: Host, world: string): string[] {
    const errors: string[] = [];
    const { manifest: m, tiles } = decodeAll(host, world);
    const cs = m.chunkSize;
    for (const p of m.packs) {
        const bytes = host.readBytes(path.join(world, p.file));
        const h = readPackHeader(bytes);
        const entries = readPackTable(bytes, m.packChunks, bytes.byteLength);
        const ph = hex64(computePackHash(entries.map(e => e.contentHash)));
        if (ph !== h.packHash) errors.push(`${p.file}: header packHash`);
        if (ph !== p.packHash) errors.push(`${p.file}: manifest packHash`);
        const maxRev = Math.max(0, ...entries.map(e => e.chunkRev));
        if (h.packRev !== maxRev || p.packRev !== maxRev) errors.push(`${p.file}: packRev`);
        entries.forEach((e, i) => {
            const raw = e.offset ? host.decompress(bytes.subarray(e.offset, e.offset + e.storedLength), "zlib") : new Uint8Array(0);
            if (raw.byteLength !== e.rawLength) errors.push(`${p.file} entry ${i}: rawLength`);
            if (hex64(xxh64(raw)) !== hex64(e.contentHash)) errors.push(`${p.file} entry ${i}: contentHash`);
        });
    }
    const tl = tileLayers(m);
    for (const role of ["collision", "nopvp"] as const) {
        const idx = tl.filter(l => l.role === role).map(l => l.tileIndex!);
        const b = host.readBytes(path.join(world, m.bitsets[role].file));
        const body = b.subarray(BITS_HEADER_BYTES);
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const header = hex64({ lo: dv.getUint32(16, true), hi: dv.getUint32(20, true) });
        if (header !== hex64(xxh64(body))) errors.push(`${role}: bodyHash`);
        if (header !== m.bitsets[role].hash) errors.push(`${role}: manifest hash`);
        const block = (cs * cs) >> 3;
        for (let cy = 0; cy < m.chunksY; cy++)
            for (let cx = 0; cx < m.chunksX; cx++) {
                const layers = idx.map(i => {
                    const out = new Uint32Array(cs * cs);
                    for (let ly = 0; ly < cs; ly++) out.set(tiles[i]!.subarray((cy * cs + ly) * m.width + cx * cs, (cy * cs + ly) * m.width + cx * cs + cs), ly * cs);
                    return out;
                });
                const want = roleBlock(layers, cs);
                const got = body.subarray((cy * m.chunksX + cx) * block, (cy * m.chunksX + cx + 1) * block);
                if (!Buffer.from(want).equals(Buffer.from(got))) errors.push(`${role}: block ${cx},${cy}`);
            }
    }
    return errors;
}

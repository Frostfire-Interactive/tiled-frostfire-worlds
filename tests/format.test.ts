import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { decodeChunkPayload, encodeChunkPayload } from "../src/lib/chunk";
import { parseManifest, stringifyManifest, tileLayers } from "../src/lib/manifest";
import { readRegionTiles } from "../src/lib/region";
import { hex64, parseHex64, xxh64 } from "../src/lib/xxh64";
import { FIXTURE_WORLD, expected, nodeHost, readWorldManifest, verifyWorld } from "./_helpers";

const te = new TextEncoder();

describe("xxh64", () => {
    test("published vectors", () => {
        for (const [k, want] of Object.entries(expected.xxh64Vectors)) {
            const b = k === "0..99" ? Uint8Array.from({ length: 100 }, (_, i) => i) : te.encode(k);
            expect(hex64(xxh64(b))).toBe(want as string);
        }
    });

    test("agrees with Bun.hash.xxHash64 on every length class", () => {
        for (let n = 0; n < 200; n++) {
            const b = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n * 7) & 255);
            const want = BigInt.asUintN(64, Bun.hash.xxHash64(b, 0n)).toString(16).padStart(16, "0");
            expect(hex64(xxh64(b))).toBe(want);
        }
    });

    test("hex round trip", () => {
        expect(hex64(parseHex64("0123456789abcdef"))).toBe("0123456789abcdef");
        expect(() => parseHex64("xyz")).toThrow();
    });
});

describe("chunk payload", () => {
    test("exact bytes of all four encodings", () => {
        const vec = [
            new Array(64).fill(5),
            Array.from({ length: 64 }, (_, k) => (k === 0 || k === 9 ? 457 : 0)),
            Array.from({ length: 64 }, (_, k) => k * 3),
            Array.from({ length: 64 }, (_, k) => (k === 63 ? 0x80000000 + 7 : k)),
            new Array(64).fill(0),
        ].map(a => Uint32Array.from(a));
        const p = encodeChunkPayload(vec, 8);
        expect(Buffer.from(p.raw).toString("hex")).toBe(expected.payloadVector.rawHex);
        expect(p.layerMask).toBe(expected.payloadVector.layerMask);
        expect(hex64(xxh64(p.raw))).toBe(expected.payloadVector.contentHash);
        expect(decodeChunkPayload(p.raw, p.layerMask, 5, 8).map(a => [...a])).toEqual(vec.map(a => [...a]));
    });

    test("an all-zero chunk is an empty payload", () => {
        const p = encodeChunkPayload([new Uint32Array(64), new Uint32Array(64)], 8);
        expect(p.raw.byteLength).toBe(0);
        expect(p.layerMask).toBe(0);
    });
});

describe("fixture world", () => {
    const host = nodeHost();

    test("manifest text is canonical", () => {
        const text = fs.readFileSync(path.join(FIXTURE_WORLD, "manifest.json"), "utf8");
        expect(stringifyManifest(parseManifest(text))).toBe(text);
    });

    test("a whole-world region decodes to the golden layer hashes", () => {
        const m = readWorldManifest(FIXTURE_WORLD);
        const tiles = readRegionTiles(host, FIXTURE_WORLD, m, { x: 0, y: 0, width: m.width, height: m.height });
        for (const l of tileLayers(m)) expect(hex64(xxh64(new Uint8Array(tiles[l.tileIndex!]!.buffer)))).toBe(expected.layerTileHashes[l.name]);
    });

    test("a partial region matches the same tiles of the whole world", () => {
        const m = readWorldManifest(FIXTURE_WORLD);
        const all = readRegionTiles(host, FIXTURE_WORLD, m, { x: 0, y: 0, width: m.width, height: m.height });
        const r = { x: 37, y: 61, width: 100, height: 90 };
        const part = readRegionTiles(host, FIXTURE_WORLD, m, r);
        for (let l = 0; l < all.length; l++)
            for (let y = 0; y < r.height; y++)
                for (let x = 0; x < r.width; x++) expect(part[l]![y * r.width + x]).toBe(all[l]![(r.y + y) * m.width + r.x + x]!);
    });

    test("the test verifier accepts the fixture", () => {
        expect(verifyWorld(host, FIXTURE_WORLD)).toEqual([]);
    });
});

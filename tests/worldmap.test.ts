import { describe, expect, test } from "bun:test";
import { gridPixels, spawnPixels } from "../src/lib/preview";
import { gridSize } from "../src/lib/region";
import { cellPixels, highlightPixels, parseWorldMapFile, regionSizesFor, stringifyWorldMapFile } from "../src/lib/worldmap";
import { copyFixture, readWorldManifest } from "./_helpers";

describe("world map", () => {
    const fixture = readWorldManifest(copyFixture());
    const big = { ...fixture, width: 10240, height: 10240, chunksX: 160, chunksY: 160 };

    test("cells are a power of two pixels, the picture stays near 2048 pixels and the scale is whole", () => {
        for (const size of [256, 512, 1024]) {
            const px = cellPixels(big, size);
            const { columns } = gridSize(big, size);
            expect(Math.log2(px) % 1).toBe(0);
            expect(px * columns).toBeLessThanOrEqual(2048);
            expect(size % px).toBe(0);
        }
        expect(cellPixels(big, 256)).toBe(32);
        expect(cellPixels(big, 512)).toBe(64);
        expect(cellPixels(big, 1024)).toBe(128);
    });

    test("grid lines fall on region edges, spawn dot is red in the middle", () => {
        const g = gridPixels(64, 32, 16);
        expect(g[5 * 64 + 16]).not.toBe(0);
        expect(g[5 * 64 + 17]).toBe(0);
        expect(g[16 * 64 + 3]).not.toBe(0);
        const s = spawnPixels(9);
        expect(s[4 * 9 + 4]).toBe(0xffe63946);
        expect(s[0]).toBe(0);
    });

    test("region sizes that split the world", () => {
        expect(regionSizesFor(big)).toEqual([256, 512, 1024]);
        expect(regionSizesFor({ ...fixture, width: 2048, height: 2048 })).toEqual([256, 512, 1024]);
        expect(regionSizesFor({ ...fixture, width: 512, height: 512 })).toEqual([256]);
        expect(regionSizesFor(fixture)).toEqual([256]);
    });

    test("world map file round trip", () => {
        const w = { format: "worldmap" as const, version: 1 as const, world: "../maps/overworld.world", size: 512, tilesetDir: "../tilesets" };
        expect(parseWorldMapFile(stringifyWorldMapFile(w))).toEqual(w);
        expect(() => parseWorldMapFile("{}")).toThrow();
    });

    test("highlight tiles: outline only, then tinted selection", () => {
        const cell = 32;
        const px = highlightPixels(cell);
        expect(px.length).toBe(cell * cell * 2);
        expect(px[0]).toBe(0xe6ffffff);
        expect(px[16 * cell * 2 + 16]).toBe(0x00000000);
        expect(px[cell]).toBe(0xffffd60a);
        expect(px[16 * cell * 2 + cell + 16]).toBe(0x55ffd60a);
    });
});

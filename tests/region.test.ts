import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { normalizePath, relativePath, resolvePath } from "../src/lib/host";
import { tileLayers } from "../src/lib/manifest";
import { artLayers, parseColor, renderPack } from "../src/lib/preview";
import {
    type Rect,
    defaultRect,
    gridCellAt,
    gridRect,
    gridSize,
    makeRegionFile,
    neighbourRect,
    parseRegionFile,
    regionTitle,
    regionToTiled,
    saveRegion,
    snapRect,
    stringifyRegionFile,
} from "../src/lib/region";
import { copyFixture, decodeAll, nodeHost, readWorldManifest, verifyWorld } from "./_helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Open a region the way the plugin does and return the Tiled JSON with every tile layer as a plain array. */
function open(world: string, rect: Rect) {
    const host = nodeHost();
    const m = readWorldManifest(world);
    const { map, snapshot } = regionToTiled(host, world, m, rect);
    for (const l of map.layers) {
        if (l.type !== "tilelayer") continue;
        const b = host.decompress(host.base64Decode(l.data), "zlib");
        l.data = Array.from(new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4));
        delete l.encoding;
        delete l.compression;
    }
    return { host, manifest: m, map, snapshot };
}

const layer = (map: any, name: string) => map.layers.find((l: any) => l.name === name);

describe("saveRegion", () => {
    test("an unchanged region writes nothing", () => {
        const world = copyFixture();
        const rect = { x: 0, y: 0, width: 256, height: 256 };
        const { host, manifest, map } = open(world, rect);
        // Tiled adds default keys to objects on export
        for (const l of map.layers) for (const o of l.objects ?? []) Object.assign(o, { rotation: 0, visible: true, opacity: 1 });
        const r = saveRegion(host, world, rect, map, { generationId: manifest.generationId });
        expect(r.written).toBe(false);
        expect(host.written).toEqual([]);
    });

    test("Tiled's export conventions are not edits: default keys added, empty lists left out", () => {
        const world = copyFixture();
        const text = fs.readFileSync(path.join(world, "manifest.json"), "utf8");
        // give one object an empty property list, as the generator writes for graveyards
        const m0 = readWorldManifest(world);
        const target = m0.objects[0]!;
        const withEmpty = text.replace(JSON.stringify(target), JSON.stringify({ ...target, properties: [] }));
        expect(withEmpty).not.toBe(text);
        fs.writeFileSync(path.join(world, "manifest.json"), withEmpty);
        const rect = { x: 0, y: 0, width: 256, height: 256 };
        const { host, manifest, map } = open(world, rect);
        for (const l of map.layers)
            for (const o of l.objects ?? []) {
                Object.assign(o, { rotation: 0, visible: true, opacity: 1 });
                if (Array.isArray(o.properties) && o.properties.length === 0) delete o.properties;
            }
        const r = saveRegion(host, world, rect, map, { generationId: manifest.generationId });
        expect(r.written).toBe(false);
    });

    test("tile edits in an unaligned region change only those tiles and keep the world valid", () => {
        const world = copyFixture();
        const rect = { x: 37, y: 61, width: 100, height: 90 };
        const { host, manifest, map } = open(world, rect);
        const before = decodeAll(host, world);
        const tl = tileLayers(manifest);
        const ground = layer(map, "Ground");
        const coll = layer(map, "Collisions");
        ground.data[5 * rect.width + 5] = 777;
        coll.data[40 * rect.width + 50] = coll.data[40 * rect.width + 50] ? 0 : 1;
        coll.data[89 * rect.width + 99] = 0x80000000 | 3; // flip flag kept

        const r = saveRegion(host, world, rect, map, { generationId: manifest.generationId });
        expect(r.written).toBe(true);
        expect(r.worldRev).toBe(manifest.worldRev + 1);
        expect(verifyWorld(host, world)).toEqual([]);

        const after = decodeAll(host, world);
        const gi = tl.find(l => l.name === "Ground")!.tileIndex!;
        const ci = tl.find(l => l.name === "Collisions")!.tileIndex!;
        const at = (x: number, y: number) => (rect.y + y) * manifest.width + rect.x + x;
        const changes: Record<number, Record<number, number>> = {
            [gi]: { [at(5, 5)]: 777 },
            [ci]: { [at(50, 40)]: coll.data[40 * rect.width + 50], [at(99, 89)]: (0x80000000 | 3) >>> 0 },
        };
        for (let l = 0; l < tl.length; l++)
            for (let i = 0; i < after.tiles[l]!.length; i++) {
                const want = changes[l]?.[i] ?? before.tiles[l]![i];
                if (after.tiles[l]![i] !== want) throw new Error(`layer ${l} tile ${i}: ${after.tiles[l]![i]} != ${want}`);
            }
        // chunkRev rises on exactly the changed chunks
        const cs = manifest.chunkSize;
        const changed = new Set(r.changedChunks.map(c => c.cy * manifest.chunksX + c.cx));
        expect(changed.size).toBeGreaterThan(0);
        for (let i = 0; i < after.revs.length; i++) expect(after.revs[i]).toBe(before.revs[i]! + (changed.has(i) ? 1 : 0));
        for (const c of r.changedChunks) {
            expect(c.cx * cs + cs > rect.x && c.cx * cs < rect.x + rect.width).toBe(true);
            expect(c.cy * cs + cs > rect.y && c.cy * cs < rect.y + rect.height).toBe(true);
        }
        expect(readWorldManifest(world).worldRev).toBe(manifest.worldRev + 1);
    });

    test("erasing a whole chunk stores it as an empty record", () => {
        const world = copyFixture();
        const rect = { x: 64, y: 64, width: 64, height: 64 };
        const { host, manifest, map } = open(world, rect);
        for (const l of map.layers) if (l.type === "tilelayer") l.data.fill(0);
        const r = saveRegion(host, world, rect, map, { generationId: manifest.generationId });
        expect(r.changedChunks).toEqual([{ cx: 1, cy: 1 }]);
        expect(verifyWorld(host, world)).toEqual([]);
        const after = decodeAll(host, world);
        for (const t of after.tiles) for (let y = 64; y < 128; y++) for (let x = 64; x < 128; x++) expect(t[y * 256 + x]).toBe(0);
    });

    test("base64 zlib layer data, as Tiled exports it, is read", () => {
        const world = copyFixture();
        const rect = { x: 0, y: 0, width: 64, height: 64 };
        const host = nodeHost();
        const m = readWorldManifest(world);
        const { map } = regionToTiled(host, world, m, rect);
        const r = saveRegion(host, world, rect, map, { generationId: m.generationId });
        expect(r.written).toBe(false);
    });

    test("objects are moved, removed and added; unedited ones keep their bytes", () => {
        const world = copyFixture();
        const rect = { x: 0, y: 0, width: 256, height: 256 };
        const { host, manifest, map } = open(world, rect);
        const warps = layer(map, "Warps");
        const graves = layer(map, "Graveyards");
        expect(warps.objects.length).toBe(1);
        expect(graves.objects.length).toBe(1);
        const warp = warps.objects[0];
        const origWarp = manifest.objects.find(o => o.id === warp.id)!;
        Object.assign(warp, { rotation: 0, visible: true, x: warp.x + 16 });
        graves.objects = [{ id: manifest.nextObjectId, name: "Grave_new", type: "graveyard", x: 32, y: 48, width: 0, height: 0, point: true, rotation: 0, visible: true }];

        const r = saveRegion(host, world, rect, map, { generationId: manifest.generationId });
        expect(r).toMatchObject({ objectsAdded: 1, objectsUpdated: 1, objectsRemoved: 1 });
        const m = readWorldManifest(world);
        const w = m.objects.find(o => o.id === warp.id)!;
        expect(w).toEqual({ ...origWarp, x: origWarp.x + 16 });
        expect(Object.keys(w)).toEqual(Object.keys(origWarp));
        const g = m.objects.find(o => o.layer === "Graveyards")!;
        expect(g).toEqual({ id: manifest.nextObjectId, layer: "Graveyards", name: "Grave_new", type: "graveyard", x: 32, y: 48, point: true });
        expect(m.nextObjectId).toBe(manifest.nextObjectId + 1);
        // Tiles untouched: packs and bitsets not written
        expect(r.packsWritten).toBe(0);
        expect(host.written.map(p => path.basename(p))).toEqual(["manifest.json"]);
    });

    test("objects outside the region are kept", () => {
        const world = copyFixture();
        const m0 = readWorldManifest(world);
        const outside = m0.objects.map(o => ({ x: Math.floor(o.x / 16), y: Math.floor(o.y / 16) }));
        // a region that holds none of the objects
        const rect = [{ x: 0, y: 0 }, { x: 192, y: 0 }, { x: 0, y: 192 }, { x: 192, y: 192 }]
            .map(p => ({ ...p, width: 64, height: 64 }))
            .find(r => outside.every(o => o.x < r.x || o.x >= r.x + 64 || o.y < r.y || o.y >= r.y + 64))!;
        const { host, manifest, map } = open(world, rect);
        for (const l of map.layers) if (l.type === "objectgroup") expect(l.objects).toEqual([]);
        const r = saveRegion(host, world, rect, map, { generationId: manifest.generationId });
        expect(r.written).toBe(false);
        expect(readWorldManifest(world).objects).toEqual(m0.objects);
    });

    test("tilesets reordered in Tiled map back to the world's gids", () => {
        const world = copyFixture();
        const rect = { x: 0, y: 0, width: 128, height: 128 };
        const { host, manifest, map } = open(world, rect);
        expect(map.tilesets.length).toBeGreaterThan(1);
        // Reverse the tileset order, renumbering firstgids, and remap every gid as Tiled would
        const old = map.tilesets.map((t: any) => ({ ...t }));
        let next = 1;
        const renum = old.slice().reverse().map((t: any) => {
            const n = { ...t, firstgid: next };
            next += t.tilecount;
            return n;
        });
        const remap = (g: number) => {
            if (!g) return 0;
            const id = g & 0x0fffffff;
            const t = old.filter((t: any) => t.firstgid <= id).sort((a: any, b: any) => b.firstgid - a.firstgid)[0];
            const n = renum.find((x: any) => x.name === t.name);
            return ((id - t.firstgid + n.firstgid) | (g & 0xf0000000)) >>> 0;
        };
        map.tilesets = renum;
        for (const l of map.layers) if (l.type === "tilelayer") l.data = l.data.map(remap);
        const r = saveRegion(host, world, rect, map, { generationId: manifest.generationId });
        expect(r.written).toBe(false);
    });

    test("a tileset the world does not have is refused", () => {
        const world = copyFixture();
        const rect = { x: 0, y: 0, width: 64, height: 64 };
        const { host, manifest, map } = open(world, rect);
        const extra = 1 + Math.max(...map.tilesets.map((t: any) => t.firstgid + t.tilecount));
        map.tilesets.push({ name: "stranger", firstgid: extra, tilecount: 10 });
        layer(map, "Ground").data[0] = extra + 1;
        expect(() => saveRegion(host, world, rect, map, { generationId: manifest.generationId })).toThrow(/stranger/);
    });

    test("refuses a regenerated world, a resized map and unknown layers", () => {
        const world = copyFixture();
        const rect = { x: 0, y: 0, width: 64, height: 64 };
        const { host, manifest, map } = open(world, rect);
        expect(() => saveRegion(host, world, rect, map, { generationId: "0000000000000000" })).toThrow(/generated again/);
        expect(() => saveRegion(host, world, rect, { ...map, width: 65 }, { generationId: manifest.generationId })).toThrow(/Resizing/);
        const extraLayer = { ...map, layers: [...map.layers, { ...layer(map, "Ground"), name: "New layer" }] };
        expect(() => saveRegion(host, world, rect, extraLayer, { generationId: manifest.generationId })).toThrow(/New layer/);
        expect(host.written).toEqual([]);
    });

    test("asks before overwriting tiles someone else saved in the same region", () => {
        const world = copyFixture();
        const rect = { x: 0, y: 0, width: 64, height: 64 };
        const mine = open(world, rect);
        const theirs = open(world, rect);
        layer(theirs.map, "Ground").data[1] = 99;
        saveRegion(theirs.host, world, rect, theirs.map, { generationId: theirs.manifest.generationId, snapshot: theirs.snapshot });
        layer(mine.map, "Ground").data[0] = 12;
        const opts = { generationId: mine.manifest.generationId, snapshot: mine.snapshot };
        let asked = "";
        expect(() => saveRegion(mine.host, world, rect, mine.map, { ...opts, confirmStale: m => ((asked = m), false) })).toThrow(/Not saved/);
        expect(asked).toMatch(/tiles/);
        const r = saveRegion(mine.host, world, rect, mine.map, { ...opts, confirmStale: () => true });
        expect(r.written).toBe(true);
        // the next save compares against what this save left
        layer(mine.map, "Ground").data[2] = 13;
        expect(saveRegion(mine.host, world, rect, mine.map, { ...opts, snapshot: r.snapshot, confirmStale: () => false }).written).toBe(true);
    });

    test("saving twice in a row does not ask, also after adding an object", () => {
        const world = copyFixture();
        const rect = { x: 0, y: 0, width: 256, height: 256 };
        const { host, manifest, map, snapshot } = open(world, rect);
        // keys in Tiled's order, which the manifest writer reorders
        layer(map, "Warps").objects.push({ height: 16, id: manifest.nextObjectId, name: "w", properties: [{ name: "map", type: "string", value: "x" }], type: "warp", width: 32, x: 40, y: 40 });
        layer(map, "Ground").data[0] = 3;
        const never = () => { throw new Error("should not ask"); };
        const r1 = saveRegion(host, world, rect, map, { generationId: manifest.generationId, snapshot, confirmStale: never });
        expect(r1.written).toBe(true);
        layer(map, "Ground").data[1] = 4;
        const r2 = saveRegion(host, world, rect, map, { generationId: manifest.generationId, snapshot: r1.snapshot, confirmStale: never });
        expect(r2.written).toBe(true);
        expect(r2.objectsAdded).toBe(0);
    });

    test("saves in other regions of the world do not ask", () => {
        const world = copyFixture();
        const a = open(world, { x: 0, y: 0, width: 64, height: 64 });
        const b = open(world, { x: 128, y: 128, width: 64, height: 64 });
        layer(b.map, "Ground").data[0] = 5;
        saveRegion(b.host, world, { x: 128, y: 128, width: 64, height: 64 }, b.map, { generationId: b.manifest.generationId, snapshot: b.snapshot });
        layer(a.map, "Ground").data[0] = 7;
        const r = saveRegion(a.host, world, { x: 0, y: 0, width: 64, height: 64 }, a.map, {
            generationId: a.manifest.generationId,
            snapshot: a.snapshot,
            confirmStale: () => { throw new Error("should not ask"); },
        });
        expect(r.written).toBe(true);
        expect(verifyWorld(a.host, world)).toEqual([]);
    });
});

describe("region files and rectangles", () => {
    test("region file round trip with relative paths", () => {
        const r = makeRegionFile("F:/a/regions/one.region", "F:/a/maps/overworld.world", { x: 64, y: 128, width: 512, height: 512 }, "0123456789abcdef", "F:/a/tilesets");
        expect(r.world).toBe("../maps/overworld.world");
        expect(r.tilesetDir).toBe("../tilesets");
        const back = parseRegionFile(stringifyRegionFile(r));
        expect(back).toEqual(r);
        expect(resolvePath("F:/a/regions", back.world)).toBe("F:/a/maps/overworld.world");
    });

    test("region grid, neighbours and titles", () => {
        const m = { ...readWorldManifest(copyFixture()), id: "over/world", width: 1280, height: 1024 };
        expect(gridSize(m, 512)).toEqual({ columns: 3, rows: 2 });
        // edge cells are cut off by the world's edge
        expect(gridRect(m, 512, 2, 1)).toEqual({ x: 1024, y: 512, width: 256, height: 512 });
        expect(gridRect(m, 512, 9, 9)).toEqual({ x: 1024, y: 512, width: 256, height: 512 });
        expect(gridRect(m, 0, 0, 0)).toEqual({ x: 0, y: 0, width: 1280, height: 1024 });
        expect(gridCellAt(m, 512, 600, 1000)).toEqual({ column: 1, row: 1 });

        const cell = gridRect(m, 512, 1, 0);
        expect(neighbourRect(m, cell, 1, 0)).toEqual(gridRect(m, 512, 2, 0));
        expect(neighbourRect(m, cell, 0, 1)).toEqual(gridRect(m, 512, 1, 1));
        expect(neighbourRect(m, cell, 0, -1)).toBeNull();
        expect(neighbourRect(m, gridRect(m, 512, 2, 0), 1, 0)).toBeNull();
        expect(neighbourRect(m, gridRect(m, 512, 2, 0), -1, 0)).toEqual(cell);
        expect(neighbourRect(m, gridRect(m, 0, 0, 0), 1, 0)).toBeNull();
        // a free rectangle moves by its own size and stops at the edge
        expect(neighbourRect(m, { x: 64, y: 0, width: 192, height: 128 }, 1, 0)).toEqual({ x: 256, y: 0, width: 192, height: 128 });
        expect(neighbourRect(m, { x: 1088, y: 0, width: 192, height: 128 }, 1, 0)).toBeNull();

        expect(regionTitle(m, cell)).toBe("over_world - 512 - column 2, row 1");
        expect(regionTitle(m, gridRect(m, 0, 0, 0))).toBe("over_world - whole world");
        expect(regionTitle(m, { x: 64, y: 32, width: 100, height: 100 })).toBe("over_world - 64,32 100x100");
    });

    test("pack picture shows the top art tile of each sampled spot in its colour", () => {
        const world = copyFixture();
        const host = nodeHost();
        const { manifest: m, tiles } = decodeAll(host, world);
        let maxGid = 0;
        for (const t of tiles) for (const v of t) maxGid = Math.max(maxGid, v & 0x0fffffff);
        // a distinct opaque colour per gid
        const colors = new Uint32Array(maxGid + 1);
        for (let g = 1; g <= maxGid; g++) colors[g] = (0xff000000 | g) >>> 0;
        const scale = 4, bg = 0xff123456;
        const pic = renderPack(host, world, m, 0, 0, scale, colors, bg);
        expect(pic).toMatchObject({ width: 64, height: 64, x: 0, y: 0 });
        const art = artLayers(m);
        expect(art.length).toBeGreaterThan(0);
        for (let py = 0; py < pic.height; py++)
            for (let px = 0; px < pic.width; px++) {
                const i = (py * scale + 2) * m.width + px * scale + 2;
                let want = bg;
                for (const l of art) if (tiles[l]![i]! & 0x0fffffff) want = colors[tiles[l]![i]! & 0x0fffffff]!;
                if (pic.pixels[py * pic.width + px] !== want) throw new Error(`pixel ${px},${py}`);
            }
        // without tile colours: blocked where a collision layer has a tile
        const plain = renderPack(host, world, m, 0, 0, scale, null);
        const coll = tileLayers(m).filter(l => l.role === "collision").map(l => l.tileIndex!);
        for (let py = 0; py < plain.height; py += 7)
            for (let px = 0; px < plain.width; px += 5) {
                const i = (py * scale + 2) * m.width + px * scale + 2;
                const blocked = coll.some(l => tiles[l]![i] !== 0);
                expect(plain.pixels[py * plain.width + px]).toBe(blocked ? 0xff2f4858 : 0xff9cc17a);
            }
    });

    test("see-through tiles blend over the layers below", () => {
        const world = copyFixture();
        const host = nodeHost();
        const { manifest: m, tiles } = decodeAll(host, world);
        let maxGid = 0;
        for (const t of tiles) for (const v of t) maxGid = Math.max(maxGid, v & 0x0fffffff);
        const colors = new Uint32Array(maxGid + 1).fill(0x80ffffff);
        const pic = renderPack(host, world, m, 0, 0, 4, colors, 0xff000000);
        // every spot with art is lighter than the black background, never fully white
        const art = artLayers(m);
        const i = 2 * m.width + 2;
        const layersHere = art.filter(l => tiles[l]![i] !== 0).length;
        const v = pic.pixels[0]! & 255;
        expect(layersHere > 0 ? v > 0 && v < 255 : v === 0).toBe(true);
        expect(parseColor("#2f4858", 0)).toBe(0xff2f4858);
        expect(parseColor("#80ff0000", 0)).toBe(0x80ff0000);
        expect(parseColor(undefined, 7)).toBe(7);
    });

    test("paths", () => {
        expect(normalizePath("C:\\x\\y\\..\\z")).toBe("C:/x/z");
        expect(relativePath("C:/x", "D:/y")).toBe("D:/y");
        expect(relativePath("C:/x/y", "c:/X/y/z")).toBe("z");
    });

    test("snap and default rectangles", () => {
        const m = readWorldManifest(copyFixture());
        expect(snapRect(m, { x: 10, y: 70, width: 60, height: 10 })).toEqual({ x: 0, y: 64, width: 128, height: 64 });
        expect(defaultRect(m)).toEqual({ x: 0, y: 0, width: 256, height: 256 });
        const big = { ...m, width: 10240, height: 10240, spawn: { x: 83400, y: 93384 } };
        expect(defaultRect(big)).toEqual({ x: 4928, y: 5568, width: 512, height: 512 });
    });

    test("the world from Map Generation verifies a saved region (when that project is present)", async () => {
        const gen = "F:/Projects/Map Generation/src/ffworld/index.ts";
        if (!fs.existsSync(gen)) return;
        const lib = await import(gen);
        const world = copyFixture();
        const rect = { x: 3, y: 9, width: 200, height: 150 };
        const { host, manifest, map } = open(world, rect);
        for (const l of map.layers) if (l.type === "tilelayer") for (let i = 0; i < l.data.length; i += 97) l.data[i] = (i % 5) ? 0 : 1 + (i % 300);
        saveRegion(host, world, rect, map, { generationId: manifest.generationId });
        const report = lib.verifyWorld(lib.readWorldDir(world));
        expect(report.errors).toEqual([]);
    });
});

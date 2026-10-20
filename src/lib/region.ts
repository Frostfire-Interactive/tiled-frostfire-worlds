/**
 * A region of a world: a rectangle of tiles that is opened in Tiled as an ordinary finite map and saved back into
 * the world's packs, bitsets and manifest.
 *
 * Reading builds a Tiled JSON map (tile data base64 + zlib, objects with their world ids) that Tiled's own JSON
 * reader loads. Saving takes the Tiled JSON export of the edited map, re-encodes only the chunks whose payload
 * changed (chunkRev + 1), rebuilds the packs that hold them (other records are copied byte for byte), patches the
 * collision and no-PvP bitsets, and rewrites the manifest last with worldRev + 1. This mirrors the generator's
 * `importWindow` and the asset server's `/save-map-chunks`, so the files stay valid for both servers.
 */
import { ROLE_COLLISION, ROLE_NOPVP, WorldBitset, roleBlock } from "./bitset";
import { CODEC_NONE, CODEC_ZLIB, LITTLE_ENDIAN, decodeChunkPayload, encodeChunkPayload } from "./chunk";
import { type Compression, type Host, WorldError, baseName, dirName, joinPath, relativePath, resolvePath } from "./host";
import { type Manifest, type ManifestLayer, type ManifestObject, objectText, parseManifest, sortObjects, stringifyManifest, tileLayers } from "./manifest";
import {
    type ChunkRecord,
    type PackEntry,
    type PackHeader,
    EMPTY_HASH,
    buildPack,
    packTableBytes,
    readPackHeader,
    readPackTable,
    recordFromEntry,
} from "./pack";
import { parseHex64, xxh64 } from "./xxh64";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** A rectangle in tiles. */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Contents of a `.region` file. */
export interface RegionFile {
    format: "region";
    version: 1;
    /** The `.world` directory, relative to the region file. */
    world: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** The world build the region was cut from. A regenerated world cannot take the region's edits. */
    generationId: string;
    /** Optional folder searched for tileset images by file name. Relative to the region file. */
    tilesetDir?: string;
}

/** Names of the map properties that carry the region on the opened map. */
export const PROP_WORLD = "world.folder";
export const PROP_RECT = "world.region";
export const PROP_GENERATION = "world.generationId";
export const PROP_TILESET_DIR = "world.tilesetFolder";

export const REGION_EXTENSION = "region";

export function parseRegionFile(text: string): RegionFile {
    let r: RegionFile;
    try {
        r = JSON.parse(text);
    } catch (e) {
        throw new WorldError(`not a region file (${(e as Error).message})`);
    }
    if (!r || r.format !== "region") throw new WorldError('not a region file ("format" is not "region")');
    if (r.version !== 1) throw new WorldError(`unsupported region file version ${r.version}`);
    if (typeof r.world !== "string" || !r.world) throw new WorldError("region file names no world");
    for (const k of ["x", "y", "width", "height"] as const) if (!Number.isInteger(r[k])) throw new WorldError(`region file has no ${k}`);
    return r;
}

export function stringifyRegionFile(r: RegionFile): string {
    const out: Record<string, unknown> = {
        format: "region", version: 1, world: r.world, x: r.x, y: r.y, width: r.width, height: r.height, generationId: r.generationId,
    };
    if (r.tilesetDir) out.tilesetDir = r.tilesetDir;
    return JSON.stringify(out, null, 2) + "\n";
}

/** Build a region file for `worldDir` as seen from a region file at `regionPath`. */
export function makeRegionFile(regionPath: string, worldDir: string, rect: Rect, generationId: string, tilesetDir?: string): RegionFile {
    const dir = dirName(regionPath);
    const r: RegionFile = { format: "region", version: 1, world: relativePath(dir, worldDir), ...rect, generationId };
    if (tilesetDir) r.tilesetDir = relativePath(dir, tilesetDir);
    return r;
}

export const formatRect = (r: Rect): string => `${r.x},${r.y},${r.width},${r.height}`;

export function parseRect(s: string): Rect {
    const p = String(s).split(",").map(Number);
    if (p.length !== 4 || !p.every(n => Number.isInteger(n))) throw new WorldError(`bad region rectangle "${s}"`);
    return { x: p[0]!, y: p[1]!, width: p[2]!, height: p[3]! };
}

export function readManifest(host: Host, worldDir: string): Manifest {
    const path = joinPath(worldDir, "manifest.json");
    if (!host.exists(path)) throw new WorldError(`${worldDir} is not a world: manifest.json not found`);
    return parseManifest(host.readText(path));
}

export function checkRect(m: Manifest, r: Rect): void {
    if (r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > m.width || r.y + r.height > m.height)
        throw new WorldError(`region ${formatRect(r)} is outside the ${m.width} x ${m.height} world`);
}

/**
 * The region the open dialog suggests: the whole world when it has at most 1024 x 1024 tiles, else 512 x 512 tiles
 * around the spawn point (or the centre), on chunk boundaries.
 */
export function defaultRect(m: Manifest): Rect {
    if (m.width * m.height <= 1024 * 1024) return { x: 0, y: 0, width: m.width, height: m.height };
    const cs = m.chunkSize;
    const w = Math.min(m.width, Math.max(cs, Math.floor(512 / cs) * cs));
    const h = Math.min(m.height, Math.max(cs, Math.floor(512 / cs) * cs));
    const cx = m.spawn ? Math.floor(m.spawn.x / m.tilewidth) : m.width / 2;
    const cy = m.spawn ? Math.floor(m.spawn.y / m.tileheight) : m.height / 2;
    const x = Math.max(0, Math.min(m.width - w, Math.round((cx - w / 2) / cs) * cs));
    const y = Math.max(0, Math.min(m.height - h, Math.round((cy - h / 2) / cs) * cs));
    return { x, y, width: w, height: h };
}

/**
 * Regions in the open dialog are cells of a grid of `size` x `size` tiles laid over the world from its top left
 * corner; cells at the right and bottom edges are cut off by the world's edge. Size 0 stands for the whole world.
 */
export function gridSize(m: Manifest, size: number): { columns: number; rows: number } {
    if (size <= 0) return { columns: 1, rows: 1 };
    return { columns: Math.ceil(m.width / size), rows: Math.ceil(m.height / size) };
}

/** The rectangle of grid cell (column, row), counted from 0. */
export function gridRect(m: Manifest, size: number, column: number, row: number): Rect {
    if (size <= 0) return { x: 0, y: 0, width: m.width, height: m.height };
    const { columns, rows } = gridSize(m, size);
    const c = Math.max(0, Math.min(columns - 1, Math.floor(column)));
    const r = Math.max(0, Math.min(rows - 1, Math.floor(row)));
    const x = c * size, y = r * size;
    return { x, y, width: Math.min(size, m.width - x), height: Math.min(size, m.height - y) };
}

/** The grid cell that holds tile (x, y). */
export function gridCellAt(m: Manifest, size: number, x: number, y: number): { column: number; row: number } {
    if (size <= 0) return { column: 0, row: 0 };
    const { columns, rows } = gridSize(m, size);
    return {
        column: Math.max(0, Math.min(columns - 1, Math.floor(x / size))),
        row: Math.max(0, Math.min(rows - 1, Math.floor(y / size))),
    };
}

/** The tile the world's spawn point is on, or the centre of the world. */
export function spawnTile(m: Manifest): { x: number; y: number } {
    if (m.spawn && typeof m.spawn.x === "number" && typeof m.spawn.y === "number")
        return { x: Math.floor(m.spawn.x / m.tilewidth), y: Math.floor(m.spawn.y / m.tileheight) };
    return { x: Math.floor(m.width / 2), y: Math.floor(m.height / 2) };
}

/**
 * The region next to `rect` in direction (dx, dy), of the same size, or null at the world's edge. A grid cell's
 * neighbour is the next grid cell; any other rectangle moves by its own width or height.
 */
export function neighbourRect(m: Manifest, rect: Rect, dx: number, dy: number): Rect | null {
    const size = Math.max(rect.width, rect.height);
    const onGrid = rect.x % size === 0 && rect.y % size === 0 && (rect.width === size || rect.x + rect.width === m.width) && (rect.height === size || rect.y + rect.height === m.height);
    if (onGrid && size < Math.max(m.width, m.height)) {
        const { columns, rows } = gridSize(m, size);
        const column = rect.x / size + dx, row = rect.y / size + dy;
        if (column < 0 || row < 0 || column >= columns || row >= rows) return null;
        return gridRect(m, size, column, row);
    }
    const x = rect.x + dx * rect.width, y = rect.y + dy * rect.height;
    if (x + rect.width <= 0 || y + rect.height <= 0 || x >= m.width || y >= m.height) return null;
    const clamped = {
        x: Math.max(0, Math.min(m.width - rect.width, x)),
        y: Math.max(0, Math.min(m.height - rect.height, y)),
        width: rect.width,
        height: rect.height,
    };
    return clamped.x === rect.x && clamped.y === rect.y ? null : clamped;
}

/** A short human name for a region, used as its file name and so as the title of its tab in Tiled. */
export function regionTitle(m: Manifest, rect: Rect): string {
    const id = m.id.replace(/[\\/:*?"<>|]/g, "_");
    if (rect.x === 0 && rect.y === 0 && rect.width === m.width && rect.height === m.height) return `${id} - whole world`;
    const size = Math.max(rect.width, rect.height);
    if (rect.x % size === 0 && rect.y % size === 0) return `${id} - ${size} - column ${rect.x / size + 1}, row ${rect.y / size + 1}`;
    return `${id} - ${rect.x},${rect.y} ${rect.width}x${rect.height}`;
}

/** Grow a rectangle to whole chunks, inside the world. */
export function snapRect(m: Manifest, r: Rect): Rect {
    const cs = m.chunkSize;
    const x0 = Math.max(0, Math.floor(r.x / cs) * cs);
    const y0 = Math.max(0, Math.floor(r.y / cs) * cs);
    const x1 = Math.min(m.width, Math.max(x0 + cs, Math.ceil((r.x + r.width) / cs) * cs));
    const y1 = Math.min(m.height, Math.max(y0 + cs, Math.ceil((r.y + r.height) / cs) * cs));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Packs                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------ */

function checkPackHeader(h: PackHeader, m: Manifest, px: number, py: number, file: string): void {
    if (h.packX !== px || h.packY !== py) throw new WorldError(`${file}: header says pack ${h.packX},${h.packY}`);
    if (h.chunkSize !== m.chunkSize || h.packChunks !== m.packChunks) throw new WorldError(`${file}: geometry disagrees with the manifest`);
    if (h.tileLayerCount !== tileLayers(m).length) throw new WorldError(`${file}: ${h.tileLayerCount} tile layers, manifest has ${tileLayers(m).length}`);
    if (h.generationId !== m.generationId) throw new WorldError(`${file}: generationId disagrees with the manifest`);
}

function rawPayload(host: Host, stored: Uint8Array, entry: PackEntry, where: string): Uint8Array {
    if (entry.offset === 0) return new Uint8Array(0);
    const raw = entry.codec === CODEC_NONE ? stored : host.decompress(stored, "zlib");
    if (raw.byteLength !== entry.rawLength) throw new WorldError(`${where}: record decompresses to ${raw.byteLength} bytes, expected ${entry.rawLength}`);
    return raw;
}

/** Calls `fn` for every chunk overlapping `rect`, grouped by pack. */
function forEachPack(m: Manifest, rect: Rect, fn: (px: number, py: number, chunks: { cx: number; cy: number; index: number }[]) => void): void {
    const cs = m.chunkSize, pc = m.packChunks;
    const cx0 = Math.floor(rect.x / cs), cx1 = Math.floor((rect.x + rect.width - 1) / cs);
    const cy0 = Math.floor(rect.y / cs), cy1 = Math.floor((rect.y + rect.height - 1) / cs);
    for (let py = Math.floor(cy0 / pc); py <= Math.floor(cy1 / pc); py++) {
        for (let px = Math.floor(cx0 / pc); px <= Math.floor(cx1 / pc); px++) {
            const chunks: { cx: number; cy: number; index: number }[] = [];
            for (let cy = Math.max(cy0, py * pc); cy <= Math.min(cy1, py * pc + pc - 1); cy++)
                for (let cx = Math.max(cx0, px * pc); cx <= Math.min(cx1, px * pc + pc - 1); cx++)
                    chunks.push({ cx, cy, index: (cy - py * pc) * pc + (cx - px * pc) });
            fn(px, py, chunks);
        }
    }
}

/**
 * Read the tiles of `rect`: one `width * height` array per tile layer, in `tileIndex` order, with raw gids
 * (flip flags included). Only the records of the chunks inside the rectangle are read from disk.
 */
export function readRegionTiles(host: Host, worldDir: string, m: Manifest, rect: Rect): Uint32Array[] {
    checkRect(m, rect);
    const cs = m.chunkSize;
    const n = tileLayers(m).length;
    const out = Array.from({ length: n }, () => new Uint32Array(rect.width * rect.height));
    forEachPack(m, rect, (px, py, chunks) => {
        const file = m.packs[py * m.packsX + px]!.file;
        const path = joinPath(worldDir, file);
        const tableLength = packTableBytes(m.packChunks);
        const head = host.readRanges(path, [{ offset: 0, length: tableLength }])[0]!;
        if (head.byteLength < tableLength) throw new WorldError(`${file}: truncated pack table`);
        checkPackHeader(readPackHeader(head), m, px, py, file);
        const entries = readPackTable(head, m.packChunks, Infinity);
        const wanted = chunks.filter(c => entries[c.index]!.offset !== 0);
        const stored = host.readRanges(path, wanted.map(c => ({ offset: entries[c.index]!.offset, length: entries[c.index]!.storedLength })));
        wanted.forEach((c, k) => {
            const e = entries[c.index]!;
            const where = `${file} chunk ${c.cx},${c.cy}`;
            if (stored[k]!.byteLength !== e.storedLength) throw new WorldError(`${where}: record is cut short`);
            const layers = decodeChunkPayload(rawPayload(host, stored[k]!, e, where), e.layerMask, n, cs);
            const x0 = Math.max(rect.x, c.cx * cs), x1 = Math.min(rect.x + rect.width, c.cx * cs + cs);
            const y0 = Math.max(rect.y, c.cy * cs), y1 = Math.min(rect.y + rect.height, c.cy * cs + cs);
            for (let l = 0; l < n; l++) {
                const src = layers[l]!, dst = out[l]!;
                for (let y = y0; y < y1; y++) {
                    const s = (y - c.cy * cs) * cs - c.cx * cs;
                    const d = (y - rect.y) * rect.width - rect.x;
                    dst.set(src.subarray(s + x0, s + x1), d + x0);
                }
            }
        });
    });
    return out;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* World -> Tiled JSON                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

function tilesToBytes(tiles: Uint32Array): Uint8Array {
    if (LITTLE_ENDIAN) return new Uint8Array(tiles.buffer, tiles.byteOffset, tiles.byteLength);
    const b = new Uint8Array(tiles.length * 4);
    const dv = new DataView(b.buffer);
    for (let i = 0; i < tiles.length; i++) dv.setUint32(i * 4, tiles[i]!, true);
    return b;
}

function bytesToTiles(b: Uint8Array, where: string): Uint32Array {
    if (b.byteLength % 4) throw new WorldError(`${where}: tile data is not a multiple of 4 bytes`);
    if (LITTLE_ENDIAN) return new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const out = new Uint32Array(b.byteLength / 4);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = dv.getUint32(i * 4, true);
    return out;
}

/**
 * Find a tileset image or file. Tries, in order: the path as the manifest gives it relative to the world directory,
 * relative to the folder that holds the world, `tilesetDir/<file name>`, and `tilesets/<file name>` in the world's
 * folder and up to four folders above it (the asset server looks images up by file name in its tilesets folder).
 */
export function findTilesetFile(host: Host, worldDir: string, path: string, tilesetDir?: string): string | null {
    const name = baseName(path.replace(/\\/g, "/"));
    const candidates = [resolvePath(worldDir, path), resolvePath(dirName(worldDir), path)];
    if (tilesetDir) candidates.push(resolvePath(tilesetDir, name));
    let dir = worldDir;
    for (let i = 0; i < 5; i++) {
        candidates.push(resolvePath(dir, joinPath("tilesets", name)));
        dir = dirName(resolvePath(dir, "."));
    }
    for (const c of candidates) if (host.exists(c)) return c;
    return null;
}

export interface TiledRegion {
    /** A Tiled JSON map, ready for Tiled's JSON reader. */
    map: Json;
    warnings: string[];
    snapshot: RegionSnapshot;
}

/** What a region holds on disk: the revision of each chunk it overlaps and its objects. */
export interface RegionSnapshot {
    chunkRevs: string;
    objects: string;
}

const objectInRect = (o: ManifestObject, x0: number, y0: number, x1: number, y1: number): boolean =>
    typeof o.x === "number" && typeof o.y === "number" && o.x >= x0 && o.x < x1 && o.y >= y0 && o.y < y1;

/** Take a {@link RegionSnapshot}. Reads only the pack tables. */
export function regionSnapshot(host: Host, worldDir: string, m: Manifest, rect: Rect): RegionSnapshot {
    const revs: number[] = [];
    forEachPack(m, rect, (px, py, chunks) => {
        const file = m.packs[py * m.packsX + px]!.file;
        const head = host.readRanges(joinPath(worldDir, file), [{ offset: 0, length: packTableBytes(m.packChunks) }])[0]!;
        const entries = readPackTable(head, m.packChunks, Infinity);
        for (const c of chunks) revs.push(entries[c.index]!.chunkRev);
    });
    const x0 = rect.x * m.tilewidth, y0 = rect.y * m.tileheight;
    const x1 = x0 + rect.width * m.tilewidth, y1 = y0 + rect.height * m.tileheight;
    const objects = m.objects.filter(o => objectInRect(o, x0, y0, x1, y1)).map(objectText).sort();
    return { chunkRevs: revs.join(","), objects: objects.join("\n") };
}

/** Build the Tiled JSON map for a region. */
export function regionToTiled(host: Host, worldDir: string, m: Manifest, rect: Rect, tilesetDir?: string): TiledRegion {
    const warnings: string[] = [];
    const tiles = readRegionTiles(host, worldDir, m, rect);
    const tl = tileLayers(m);
    const x0 = rect.x * m.tilewidth, y0 = rect.y * m.tileheight;
    const x1 = x0 + rect.width * m.tilewidth, y1 = y0 + rect.height * m.tileheight;

    const tilesets = m.tilesets.map(ts => {
        const out: Json = { ...ts };
        for (const key of ["image", "source"]) {
            if (typeof out[key] !== "string") continue;
            const found = findTilesetFile(host, worldDir, out[key], tilesetDir);
            if (found) out[key] = found;
            else {
                out[key] = resolvePath(worldDir, out[key]);
                warnings.push(`Tileset "${ts.name ?? ts.source}": ${key} ${ts[key]} not found. Set a tileset folder in the region's ${PROP_TILESET_DIR} property or the open dialog.`);
            }
        }
        return out;
    });

    const layers = m.layers.map((l: ManifestLayer) => {
        const base: Json = { id: l.id, name: l.name, type: l.type, visible: l.visible !== false, opacity: 1, x: 0, y: 0 };
        if (l.locked !== undefined) base.locked = l.locked;
        if (l.properties) base.properties = l.properties;
        if (l.type === "tilelayer") {
            const data = tiles[tl.indexOf(l)]!;
            return { ...base, width: rect.width, height: rect.height, encoding: "base64", compression: "zlib", data: host.base64Encode(host.deflate(tilesToBytes(data))) };
        }
        const objects = m.objects
            .filter(o => o.layer === l.name && objectInRect(o, x0, y0, x1, y1))
            .map(o => {
                const out: Json = { ...o, x: o.x - x0, y: o.y - y0 };
                delete out.layer;
                return out;
            });
        return { ...base, draworder: l.draworder ?? "topdown", objects };
    });

    const map: Json = {
        type: "map",
        version: "1.10",
        orientation: m.orientation ?? "orthogonal",
        renderorder: m.renderorder ?? "right-down",
        infinite: false,
        width: rect.width,
        height: rect.height,
        tilewidth: m.tilewidth,
        tileheight: m.tileheight,
        compressionlevel: -1,
        nextlayerid: Math.max(0, ...m.layers.map(l => l.id)) + 1,
        nextobjectid: m.nextObjectId,
        properties: [
            { name: PROP_WORLD, type: "string", value: worldDir },
            { name: PROP_RECT, type: "string", value: formatRect(rect) },
            { name: PROP_GENERATION, type: "string", value: m.generationId },
            { name: PROP_TILESET_DIR, type: "string", value: tilesetDir ?? "" },
        ],
        tilesets,
        layers,
    };
    if (typeof m.backgroundcolor === "string") map.backgroundcolor = m.backgroundcolor;
    return { map, warnings, snapshot: regionSnapshot(host, worldDir, m, rect) };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Tiled JSON -> world                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Maps gids of the edited map's tilesets to the world's gids (tilesets may have been reordered in Tiled).
 * Returns null when every gid stays as it is.
 */
function gidMapper(json: Json, m: Manifest): ((gid: number) => number) | null {
    const byName: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const ts of m.tilesets) {
        const first = Number(ts.firstgid);
        if (typeof ts.name === "string") byName[ts.name] = first;
        if (typeof ts.source === "string") bySource[baseName(ts.source.replace(/\\/g, "/")).toLowerCase()] = first;
    }
    // `delta` is null for a tileset the world does not have
    const ranges: { first: number; delta: number | null; label: string }[] = [];
    for (const ts of (json.tilesets ?? []) as Json[]) {
        let target: number | undefined = typeof ts.name === "string" ? byName[ts.name] : undefined;
        if (target === undefined && typeof ts.source === "string") target = bySource[baseName(ts.source.replace(/\\/g, "/")).toLowerCase()];
        const first = Number(ts.firstgid);
        ranges.push({ first, delta: target === undefined ? null : target - first, label: String(ts.name ?? ts.source) });
    }
    ranges.sort((a, b) => b.first - a.first);
    if (ranges.every(r => r.delta === 0)) return null;
    return gid => {
        if (gid === 0) return 0;
        const id = gid & 0x0fffffff;
        const flags = gid & 0xf0000000;
        const r = ranges.find(t => t.first <= id);
        if (!r) throw new WorldError(`Tile gid ${id} belongs to no tileset.`);
        if (r.delta === null) throw new WorldError(`Tileset "${r.label}" is not one of the world's tilesets. Only the world's tilesets can be used.`);
        return ((id + r.delta) | flags) >>> 0;
    };
}

function layerTiles(host: Host, layer: Json, width: number, height: number, mapGid: ((g: number) => number) | null): Uint32Array {
    const where = `layer "${layer.name}"`;
    let tiles: Uint32Array;
    if (Array.isArray(layer.data)) {
        tiles = new Uint32Array(layer.data.length);
        for (let i = 0; i < tiles.length; i++) tiles[i] = Number(layer.data[i]) >>> 0;
    } else if (typeof layer.data === "string") {
        if (layer.encoding !== "base64") throw new WorldError(`${where}: unsupported tile data encoding ${layer.encoding}`);
        let b = host.base64Decode(layer.data);
        if (layer.compression) {
            if (["zlib", "gzip", "zstd"].indexOf(layer.compression) < 0) throw new WorldError(`${where}: unsupported compression ${layer.compression}`);
            b = host.decompress(b, layer.compression as Compression);
        }
        tiles = bytesToTiles(b, where);
    } else throw new WorldError(`${where}: has no tile data. Infinite maps are not supported for world regions.`);
    if (tiles.length !== width * height) throw new WorldError(`${where}: ${tiles.length} tiles, expected ${width} x ${height}`);
    if (mapGid) for (let i = 0; i < tiles.length; i++) if (tiles[i] !== 0) tiles[i] = mapGid(tiles[i]!);
    return tiles;
}

/** Keys of a Tiled JSON object. A key the world object has but the edited object lacks was removed in Tiled. */
const TILED_OBJECT_KEYS = ["name", "type", "class", "x", "y", "width", "height", "rotation", "visible", "opacity", "gid", "point", "ellipse", "polygon", "polyline", "text", "properties", "template"];
/** Values Tiled writes for every object. Left out of world objects that never had them. */
const OBJECT_DEFAULTS: Record<string, unknown> = { name: "", type: "", class: "", rotation: 0, visible: true, opacity: 1, width: 0, height: 0 };

/** The world object for an edited Tiled object: the world's own keys are kept, Tiled's values win. */
function mergeObject(orig: Record<string, unknown>, edited: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(orig)) {
        // Tiled leaves out empty lists ("properties": []), which are not a removal
        if (TILED_OBJECT_KEYS.indexOf(k) >= 0 && !(k in edited) && !(Array.isArray(orig[k]) && (orig[k] as unknown[]).length === 0)) continue;
        out[k] = k in edited ? edited[k] : orig[k];
    }
    for (const k of Object.keys(edited)) {
        if (k in out || k === "id") continue;
        if (k in OBJECT_DEFAULTS && OBJECT_DEFAULTS[k] === edited[k]) continue;
        out[k] = edited[k];
    }
    return out;
}

export interface SaveOptions {
    /** generationId the region was cut from. A regenerated world refuses the save. */
    generationId: string;
    /**
     * What the region held on disk when it was opened. When another save changed tiles or objects inside this region
     * since, `confirmStale` decides whether to overwrite them. Saves elsewhere in the world never ask.
     */
    snapshot?: RegionSnapshot;
    confirmStale?: (message: string) => boolean;
}

export interface SaveResult {
    written: boolean;
    changedChunks: { cx: number; cy: number }[];
    packsWritten: number;
    objectsAdded: number;
    objectsUpdated: number;
    objectsRemoved: number;
    worldRev: number;
    /** What the region holds on disk after the save, for the next save's check. */
    snapshot: RegionSnapshot;
}

/** Save an edited region (a Tiled JSON map) into the world. */
export function saveRegion(host: Host, worldDir: string, rect: Rect, json: Json, opts: SaveOptions): SaveResult {
    const m = readManifest(host, worldDir);
    checkRect(m, rect);
    if (m.generationId !== opts.generationId)
        throw new WorldError(`The world was generated again since this region was opened. Your edits cannot be saved into the new world. Open the region again.`);
    if (opts.snapshot) {
        const now = regionSnapshot(host, worldDir, m, rect);
        const tilesChanged = now.chunkRevs !== opts.snapshot.chunkRevs;
        const objectsChanged = now.objects !== opts.snapshot.objects;
        if (tilesChanged || objectsChanged) {
            const what = tilesChanged && objectsChanged ? "tiles and objects" : tilesChanged ? "tiles" : "objects";
            const message = `Someone else saved changes to the ${what} in this part of the world after you opened it.\n\nSaving now replaces their changes here with yours. Save anyway?`;
            if (!opts.confirmStale || !opts.confirmStale(message)) throw new WorldError("Not saved: someone else changed this part of the world. Reopen the region to see their changes.");
        }
    }
    if (json.infinite) throw new WorldError("Infinite maps are not supported for world regions.");
    if (json.width !== rect.width || json.height !== rect.height)
        throw new WorldError(`The map is ${json.width} x ${json.height} tiles but the region is ${rect.width} x ${rect.height}. Resizing a region is not supported.`);

    const cs = m.chunkSize;
    const tl = tileLayers(m);
    const mapGid = gidMapper(json, m);

    // Layers of the edited map, matched to the world's layers by name
    const edited: { index: number; tiles: Uint32Array }[] = [];
    const objectLayers: { name: string; objects: Json[] }[] = [];
    const seen: Record<string, boolean> = {};
    for (const l of (json.layers ?? []) as Json[]) {
        if (seen[l.name]) throw new WorldError(`Two layers are named "${l.name}". Layer names must be unique.`);
        seen[l.name] = true;
        const ml = m.layers.find(w => w.name === l.name);
        if (l.type === "tilelayer") {
            if (!ml || ml.type !== "tilelayer") throw new WorldError(`Tile layer "${l.name}" is not a tile layer of the world. Layers cannot be added to a world.`);
            edited.push({ index: ml.tileIndex!, tiles: layerTiles(host, l, rect.width, rect.height, mapGid) });
        } else if (l.type === "objectgroup") {
            if (!ml || ml.type !== "objectgroup") throw new WorldError(`Object layer "${l.name}" is not an object layer of the world. Layers cannot be added to a world.`);
            objectLayers.push({ name: l.name, objects: l.objects ?? [] });
        } else throw new WorldError(`Layer "${l.name}" is a ${l.type}. A world holds only tile layers and object layers.`);
    }

    // Tiles: rebuild the chunks that changed
    const collisionIdx = tl.filter(l => l.role === "collision").map(l => l.tileIndex!);
    const nopvpIdx = tl.filter(l => l.role === "nopvp").map(l => l.tileIndex!);
    let collision: WorldBitset | null = null;
    let nopvp: WorldBitset | null = null;
    const bitsets = () => {
        if (!collision) {
            collision = WorldBitset.parse(host.readBytes(joinPath(worldDir, m.bitsets.collision.file)), cs, m.chunksX, m.chunksY, ROLE_COLLISION);
            nopvp = WorldBitset.parse(host.readBytes(joinPath(worldDir, m.bitsets.nopvp.file)), cs, m.chunksX, m.chunksY, ROLE_NOPVP);
        }
        return { collision: collision!, nopvp: nopvp! };
    };
    const changedChunks: { cx: number; cy: number }[] = [];
    const packWrites: { file: string; bytes: Uint8Array; index: number; packHash: string; packRev: number }[] = [];
    const generationId = parseHex64(m.generationId);
    if (edited.length) {
        forEachPack(m, rect, (px, py, chunks) => {
            const index = py * m.packsX + px;
            const file = m.packs[index]!.file;
            const bytes = host.readBytes(joinPath(worldDir, file));
            const header = readPackHeader(bytes);
            checkPackHeader(header, m, px, py, file);
            const entries = readPackTable(bytes, m.packChunks, bytes.byteLength);
            const replaced: Record<number, ChunkRecord> = {};
            let any = false;
            for (const c of chunks) {
                const e = entries[c.index]!;
                const where = `${file} chunk ${c.cx},${c.cy}`;
                const oldRaw = rawPayload(host, recordFromEntry(bytes, e).stored, e, where);
                const layers = decodeChunkPayload(oldRaw, e.layerMask, tl.length, cs);
                const x0 = Math.max(rect.x, c.cx * cs), x1 = Math.min(rect.x + rect.width, c.cx * cs + cs);
                const y0 = Math.max(rect.y, c.cy * cs), y1 = Math.min(rect.y + rect.height, c.cy * cs + cs);
                // Copy the edited rows in, noting whether any tile differs. The encoding is a function of the
                // tiles, so a chunk with the same tiles has the same payload and is left alone.
                let differs = false;
                for (const { index: li, tiles } of edited) {
                    const dst = layers[li]!;
                    for (let y = y0; y < y1; y++) {
                        const d = (y - c.cy * cs) * cs - c.cx * cs;
                        const s = (y - rect.y) * rect.width - rect.x;
                        if (!differs) {
                            for (let x = x0; x < x1; x++) {
                                if (dst[d + x] !== tiles[s + x]) {
                                    differs = true;
                                    break;
                                }
                            }
                        }
                        dst.set(tiles.subarray(s + x0, s + x1), d + x0);
                    }
                }
                if (!differs) continue;
                const { raw, layerMask } = encodeChunkPayload(layers, cs);
                const empty = raw.byteLength === 0;
                replaced[c.index] = {
                    stored: empty ? raw : host.deflate(raw),
                    rawLength: raw.byteLength,
                    codec: empty ? CODEC_NONE : CODEC_ZLIB,
                    layerMask,
                    contentHash: empty ? EMPTY_HASH : xxh64(raw),
                    chunkRev: e.chunkRev + 1,
                };
                any = true;
                changedChunks.push({ cx: c.cx, cy: c.cy });
                const b = bitsets();
                if (collisionIdx.length) b.collision.patchChunk(c.cx, c.cy, roleBlock(collisionIdx.map(i => layers[i]!), cs));
                if (nopvpIdx.length) b.nopvp.patchChunk(c.cx, c.cy, roleBlock(nopvpIdx.map(i => layers[i]!), cs));
            }
            if (!any) return;
            const records = entries.map((e, i) => replaced[i] ?? recordFromEntry(bytes, e));
            const pack = buildPack(header, generationId, records);
            packWrites.push({ file, bytes: pack.bytes, index, packHash: pack.packHash, packRev: pack.packRev });
        });
    }

    // Objects: the world's objects inside the region, on the layers the map has, are replaced by the map's objects
    const x0 = rect.x * m.tilewidth, y0 = rect.y * m.tileheight;
    const x1 = x0 + rect.width * m.tilewidth, y1 = y0 + rect.height * m.tileheight;
    const submitted: Record<string, boolean> = {};
    for (const l of objectLayers) submitted[l.name] = true;
    const inRegion = (o: ManifestObject) => submitted[o.layer] === true && objectInRect(o, x0, y0, x1, y1);
    const before: Record<number, ManifestObject> = {};
    const kept: ManifestObject[] = [];
    const used: Record<number, boolean> = {};
    for (const o of m.objects) {
        if (inRegion(o)) before[o.id] = o;
        else {
            kept.push(o);
            used[o.id] = true;
        }
    }
    let nextObjectId = m.nextObjectId;
    let objectsAdded = 0, objectsUpdated = 0;
    const after: ManifestObject[] = [];
    for (const l of objectLayers) {
        for (const src of l.objects) {
            const conv: Json = { ...src, x: Number(src.x ?? 0) + x0, y: Number(src.y ?? 0) + y0 };
            if (typeof conv.gid === "number" && mapGid) conv.gid = mapGid(conv.gid);
            let id = Number(src.id);
            const orig = before[id];
            let obj: Record<string, unknown>;
            if (orig && !used[id]) {
                obj = mergeObject(orig, conv);
                if (orig.layer !== l.name) obj.layer = l.name;
                if (JSON.stringify(obj) !== JSON.stringify(orig)) objectsUpdated++;
            } else {
                if (!Number.isInteger(id) || id <= 0 || used[id]) id = nextObjectId;
                obj = mergeObject({}, conv);
                objectsAdded++;
            }
            obj.id = id;
            obj.layer = l.name;
            used[id] = true;
            if (id >= nextObjectId) nextObjectId = id + 1;
            after.push(obj as ManifestObject);
        }
    }
    let objectsRemoved = 0;
    const afterIds: Record<number, boolean> = {};
    for (const o of after) afterIds[o.id] = true;
    for (const id of Object.keys(before)) if (!afterIds[Number(id)]) objectsRemoved++;
    const objectsChanged = objectsAdded + objectsUpdated + objectsRemoved > 0 || nextObjectId !== m.nextObjectId;

    const result: SaveResult = {
        written: false,
        changedChunks,
        packsWritten: packWrites.length,
        objectsAdded,
        objectsUpdated,
        objectsRemoved,
        worldRev: m.worldRev,
        snapshot: { chunkRevs: "", objects: "" },
    };
    if (!packWrites.length && !objectsChanged) {
        result.snapshot = regionSnapshot(host, worldDir, m, rect);
        return result;
    }

    // Write packs, then bitsets, then the manifest: an interrupted save never looks complete
    const nm: Manifest = { ...m, worldRev: m.worldRev + 1, packs: m.packs.map(p => ({ ...p })) };
    for (const w of packWrites) {
        host.writeBytes(joinPath(worldDir, w.file), w.bytes);
        nm.packs[w.index] = { ...nm.packs[w.index]!, packHash: w.packHash, packRev: w.packRev };
    }
    if (collision && nopvp) {
        const c = collision as WorldBitset, p = nopvp as WorldBitset;
        nm.bitsets = {
            collision: { ...m.bitsets.collision, hash: c.seal() },
            nopvp: { ...m.bitsets.nopvp, hash: p.seal() },
        };
        host.writeBytes(joinPath(worldDir, m.bitsets.collision.file), c.bytes);
        host.writeBytes(joinPath(worldDir, m.bitsets.nopvp.file), p.bytes);
    }
    if (objectsChanged) {
        nm.objects = sortObjects(kept.concat(after), m.layers);
        nm.nextObjectId = nextObjectId;
    }
    host.writeText(joinPath(worldDir, "manifest.json"), stringifyManifest(nm));
    result.written = true;
    result.worldRev = nm.worldRev;
    result.snapshot = regionSnapshot(host, worldDir, nm, rect);
    return result;
}

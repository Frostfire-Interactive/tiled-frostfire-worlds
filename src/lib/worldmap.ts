/**
 * The world map: a whole world shown as a Tiled map whose tiles are the cells of the region grid. A picture of the
 * world (see `preview.ts`) fills image layers behind the grid; one map tile covers exactly one region.
 *
 * It is backed by a small `.worldmap` file that names the world and the region size.
 */
import { WorldError } from "./host";
import type { Manifest } from "./manifest";
import { gridSize } from "./region";

export const WORLDMAP_EXTENSION = "worldmap";

/** Region sizes the world map offers, in tiles. */
export const REGION_SIZES = [256, 512, 1024];
export const DEFAULT_REGION_SIZE = 512;

export interface WorldMapFile {
    format: "worldmap";
    version: 1;
    /** The `.world` directory, relative to the world map file. */
    world: string;
    /** Region size in tiles. */
    size: number;
    /** Optional folder searched for tileset images by file name. Relative to the world map file. */
    tilesetDir?: string;
}

export function parseWorldMapFile(text: string): WorldMapFile {
    let w: WorldMapFile;
    try {
        w = JSON.parse(text);
    } catch (e) {
        throw new WorldError(`not a world map file (${(e as Error).message})`);
    }
    if (!w || w.format !== "worldmap") throw new WorldError('not a world map file ("format" is not "worldmap")');
    if (w.version !== 1) throw new WorldError(`unsupported world map file version ${w.version}`);
    if (typeof w.world !== "string" || !w.world) throw new WorldError("world map file names no world");
    if (!Number.isInteger(w.size) || w.size <= 0) throw new WorldError("world map file has no region size");
    return w;
}

export function stringifyWorldMapFile(w: WorldMapFile): string {
    const out: Record<string, unknown> = { format: "worldmap", version: 1, world: w.world, size: w.size };
    if (w.tilesetDir) out.tilesetDir = w.tilesetDir;
    return JSON.stringify(out, null, 2) + "\n";
}

/** Region sizes that split this world into more than one region. */
export const regionSizesFor = (m: Manifest): number[] => {
    const sizes = REGION_SIZES.filter(s => s < Math.max(m.width, m.height));
    return sizes.length ? sizes : [REGION_SIZES[0]!];
};

/**
 * Pixels per region on the world map: a power of two, so that the picture's scale (tiles per pixel) is a whole
 * number and the grid lines fall exactly on region edges. The picture is kept near 2048 pixels across.
 */
export function cellPixels(m: Manifest, size: number): number {
    const { columns, rows } = gridSize(m, size);
    let px = 16;
    while (px * 2 <= 128 && px * 2 <= size && px * 2 * Math.max(columns, rows) <= 2048) px *= 2;
    return Math.min(px, size);
}

/** Pixels (0xAARRGGBB) of the selection, `cell` pixels square: a solid see-through yellow. */
export function selectionPixels(cell: number): Uint32Array {
    return new Uint32Array(cell * cell).fill(0x80ffd60a);
}

/** Pixels (0xAARRGGBB) of the two highlight tiles: hover outline, then the selection. `cell` pixels square each. */
export function highlightPixels(cell: number): Uint32Array {
    const out = new Uint32Array(cell * 2 * cell);
    const border = Math.max(2, Math.round(cell / 16));
    for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
            const edge = x < border || y < border || x >= cell - border || y >= cell - border;
            out[y * cell * 2 + x] = edge ? 0xe6ffffff : 0x00000000;
            out[y * cell * 2 + cell + x] = edge ? 0xffffd60a : 0x55ffd60a;
        }
    }
    return out;
}

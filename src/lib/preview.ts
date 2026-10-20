/**
 * Detailed pictures of a world for the world map, one per pack file, at a whole number of tiles per pixel.
 *
 * Each pixel shows the tile at the centre of the square of tiles it covers. The art layers (role "tiles") are blended
 * in draw order, each tile drawn in its average colour (see {@link TileColors}); empty tiles show the background.
 * Without tile colours (tileset images not found), blocked tiles from the collision layers are drawn dark on light
 * ground instead, like the plain overview.
 *
 * Only the sampled tiles are read from each chunk record: the payload is decompressed and its layer blocks are looked
 * up in place, without decoding whole chunks.
 */
import { CODEC_NONE, ENC_BIT, ENC_FILL, ENC_U16, BLOCK_HEADER } from "./chunk";
import { type Host, WorldError, joinPath } from "./host";
import { type Manifest, tileLayers } from "./manifest";
import { readPackHeader, readPackTable } from "./pack";

/** Average colour (0xAARRGGBB) of each tile, indexed by gid without flip flags. 0 is transparent. */
export type TileColors = Uint32Array;

export interface PackPicture {
    width: number;
    height: number;
    /** Position of the picture's top left corner on the whole world picture, in pixels. */
    x: number;
    y: number;
    pixels: Uint32Array;
}

const OPEN = 0xff9cc17a;
const BLOCKED = 0xff2f4858;
export const DEFAULT_BACKGROUND = 0xff2f4858;

/** Blend `top` (0xAARRGGBB, not premultiplied) over an opaque `below`. */
function over(below: number, top: number): number {
    const a = top >>> 24;
    if (a === 255) return top;
    if (a === 0) return below;
    const t = a / 255;
    const r = ((below >>> 16) & 255) * (1 - t) + ((top >>> 16) & 255) * t;
    const g = ((below >>> 8) & 255) * (1 - t) + ((top >>> 8) & 255) * t;
    const b = (below & 255) * (1 - t) + (top & 255) * t;
    return (0xff000000 | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)) >>> 0;
}

/** Parse a colour such as "#2f4858" or "#ff2f4858" into 0xAARRGGBB. */
export function parseColor(s: unknown, fallback: number): number {
    if (typeof s !== "string") return fallback;
    const m = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s);
    if (!m) return fallback;
    const v = parseInt(m[1]!, 16) >>> 0;
    return (m[1]!.length === 6 ? (0xff000000 | v) : v) >>> 0;
}

/** The tile layers drawn on the picture, in draw order, as `tileIndex` values. */
export function artLayers(m: Manifest): number[] {
    return m.layers.filter(l => l.type === "tilelayer" && l.role === "tiles").map(l => l.tileIndex!);
}

/** The tile layers whose tiles block movement, as `tileIndex` values. */
const collisionLayers = (m: Manifest): number[] => tileLayers(m).filter(l => l.role === "collision").map(l => l.tileIndex!);

/** Draw one pack. `scale` (tiles per pixel) must divide the chunk size. */
export function renderPack(host: Host, worldDir: string, m: Manifest, px: number, py: number, scale: number, colors: TileColors | null, background = DEFAULT_BACKGROUND): PackPicture {
    const cs = m.chunkSize, pc = m.packChunks;
    if (cs % scale) throw new WorldError(`picture scale ${scale} does not divide the chunk size ${cs}`);
    const tilesX = Math.min(pc * cs, m.width - px * pc * cs), tilesY = Math.min(pc * cs, m.height - py * pc * cs);
    const width = Math.ceil(tilesX / scale), height = Math.ceil(tilesY / scale);
    const pixels = new Uint32Array(width * height).fill(colors ? background : OPEN);
    const file = m.packs[py * m.packsX + px]!.file;
    const bytes = host.readBytes(joinPath(worldDir, file));
    readPackHeader(bytes);
    const entries = readPackTable(bytes, pc, bytes.byteLength);
    const layerCount = tileLayers(m).length;
    const order = colors ? artLayers(m) : collisionLayers(m);
    const perChunk = cs / scale;
    const half = scale >> 1;
    const blockOffset = new Int32Array(layerCount);

    for (let ly = 0; ly < pc; ly++) {
        for (let lx = 0; lx < pc; lx++) {
            const cx = px * pc + lx, cy = py * pc + ly;
            if (cx >= m.chunksX || cy >= m.chunksY) continue;
            const e = entries[ly * pc + lx]!;
            if (e.offset === 0) continue;
            const stored = bytes.subarray(e.offset, e.offset + e.storedLength);
            const raw = e.codec === CODEC_NONE ? stored : host.decompress(stored, "zlib");
            const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

            // Where each layer's block starts (-1 when the layer is empty in this chunk)
            let o = 0;
            for (let i = 0; i < layerCount; i++) {
                if (!(e.layerMask & (1 << i))) {
                    blockOffset[i] = -1;
                    continue;
                }
                blockOffset[i] = o;
                const enc = raw[o]!;
                const area = cs * cs;
                o += BLOCK_HEADER + (enc === ENC_FILL ? 0 : enc === ENC_BIT ? area >>> 3 : enc === ENC_U16 ? area * 2 : area * 4);
            }

            const sample = (layer: number, k: number): number => {
                const b = blockOffset[layer]!;
                if (b < 0) return 0;
                const enc = raw[b]!;
                const value = dv.getUint32(b + 4, true);
                const d = b + BLOCK_HEADER;
                if (enc === ENC_FILL) return value;
                if (enc === ENC_BIT) return (raw[d + (k >>> 3)]! >>> (k & 7)) & 1 ? value : 0;
                if (enc === ENC_U16) return raw[d + k * 2]! | (raw[d + k * 2 + 1]! << 8);
                return dv.getUint32(d + k * 4, true);
            };

            for (let sy = 0; sy < perChunk; sy++) {
                const pyPix = ly * perChunk + sy;
                if (pyPix >= height) break;
                const ty = sy * scale + half;
                for (let sx = 0; sx < perChunk; sx++) {
                    const pxPix = lx * perChunk + sx;
                    if (pxPix >= width) break;
                    const k = ty * cs + sx * scale + half;
                    let c: number;
                    if (colors) {
                        c = background;
                        for (const layer of order) {
                            const gid = sample(layer, k) & 0x0fffffff;
                            if (gid !== 0 && gid < colors.length) c = over(c, colors[gid]!);
                        }
                    } else {
                        c = OPEN;
                        for (const layer of order) if (sample(layer, k) !== 0) c = BLOCKED;
                    }
                    pixels[pyPix * width + pxPix] = c;
                }
            }
        }
    }
    const packTiles = pc * cs;
    return { width, height, x: (px * packTiles) / scale, y: (py * packTiles) / scale, pixels };
}

/** A transparent picture with grid lines every `cell` pixels. */
export function gridPixels(width: number, height: number, cell: number): Uint32Array {
    const out = new Uint32Array(width * height);
    const line = 0x40000000;
    for (let x = cell; x < width; x += cell) for (let y = 0; y < height; y++) out[y * width + x] = line;
    for (let y = cell; y < height; y += cell) for (let x = 0; x < width; x++) out[y * width + x] = line;
    return out;
}

/** A small picture of the spawn point: a red dot with a white ring, `size` pixels square. */
export function spawnPixels(size = 9): Uint32Array {
    const out = new Uint32Array(size * size);
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            const d = (x - c) * (x - c) + (y - c) * (y - c);
            out[y * size + x] = d <= (c - 2) * (c - 2) ? 0xffe63946 : d <= c * c ? 0xffffffff : 0;
        }
    return out;
}

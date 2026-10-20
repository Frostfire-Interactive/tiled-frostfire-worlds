/**
 * `manifest.json` of a world (Map Generation `src/ffworld/manifest.ts`, spec §1.2).
 *
 * The manifest is rewritten in the generator's canonical text form: one top-level key per line, one layer / pack /
 * object per line, keys in the documented order, unknown keys kept after the known ones.
 */
import { FORMAT_VERSION, MAX_TILE_LAYERS } from "./chunk";
import { WorldError } from "./host";

export type LayerRole = "tiles" | "collision" | "nopvp";

export interface TiledProperty {
    name: string;
    type?: string;
    value: unknown;
    [k: string]: unknown;
}

export interface ManifestLayer {
    id: number;
    name: string;
    type: "tilelayer" | "objectgroup";
    tileIndex?: number;
    zIndex?: number;
    role?: LayerRole;
    visible: boolean;
    locked?: boolean;
    draworder?: string;
    properties?: TiledProperty[];
    [k: string]: unknown;
}

export interface ManifestObject {
    id: number;
    /** Name of the objectgroup layer the object belongs to. */
    layer: string;
    x: number;
    y: number;
    [k: string]: unknown;
}

export interface ManifestPack {
    px: number;
    py: number;
    file: string;
    packHash: string;
    packRev: number;
}

export interface Manifest {
    format: "ffworld";
    formatVersion: number;
    id: string;
    generationId: string;
    worldRev: number;
    width: number;
    height: number;
    tilewidth: number;
    tileheight: number;
    chunkSize: number;
    packChunks: number;
    chunksX: number;
    chunksY: number;
    packsX: number;
    packsY: number;
    orientation?: string;
    renderorder?: string;
    layers: ManifestLayer[];
    tilesets: Record<string, unknown>[];
    bitsets: { collision: { file: string; hash: string }; nopvp: { file: string; hash: string } };
    packs: ManifestPack[];
    spawn?: { x: number; y: number } | null;
    nextObjectId: number;
    objects: ManifestObject[];
    [k: string]: unknown;
}

/** Top-level key order of the canonical text. */
export const MANIFEST_KEYS = [
    "format", "formatVersion", "id", "generationId", "worldRev", "width", "height", "tilewidth", "tileheight", "chunkSize",
    "packChunks", "chunksX", "chunksY", "packsX", "packsY", "orientation", "renderorder", "layers", "tilesets", "bitsets",
    "packs", "spawn", "nextObjectId", "objects", "warps", "graveyards", "source",
];
const LAYER_KEYS = ["id", "name", "type", "tileIndex", "zIndex", "role", "visible", "locked", "draworder", "properties", "tiled"];
const OBJECT_HEAD = ["id", "layer", "name", "type", "x", "y", "width", "height", "point", "properties"];

/** Tile layers in `tileIndex` order. */
export const tileLayers = (m: Pick<Manifest, "layers">): ManifestLayer[] =>
    m.layers.filter(l => l.type === "tilelayer").sort((a, b) => a.tileIndex! - b.tileIndex!);

function ordered(o: Record<string, unknown>, head: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of head) if (o[k] !== undefined) out[k] = o[k];
    for (const k of Object.keys(o)) if (!(k in out) && o[k] !== undefined) out[k] = o[k];
    return out;
}

/** An object as the canonical manifest text writes it. */
export const objectText = (o: ManifestObject): string => JSON.stringify(ordered(o, OBJECT_HEAD));

/** Canonical manifest text: LF line ends and a trailing newline. */
export function stringifyManifest(m: Manifest): string {
    const obj = m as Record<string, unknown>;
    const lines: string[] = [];
    for (const k of MANIFEST_KEYS) {
        const v = obj[k];
        if (v === undefined) continue;
        if (k === "layers" || k === "packs" || k === "objects") {
            const arr = (v as Record<string, unknown>[]).map(e =>
                JSON.stringify(k === "layers" ? ordered(e, LAYER_KEYS) : k === "objects" ? ordered(e, OBJECT_HEAD) : e)
            );
            lines.push(`  ${JSON.stringify(k)}: ${arr.length ? `[\n    ${arr.join(",\n    ")}\n  ]` : "[]"}`);
            continue;
        }
        lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    }
    for (const k of Object.keys(obj)) if (MANIFEST_KEYS.indexOf(k) < 0 && obj[k] !== undefined) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`);
    return `{\n${lines.join(",\n")}\n}\n`;
}

/** Sort objects by (layer id, object id), as the generator writes them. */
export function sortObjects(objects: ManifestObject[], layers: ManifestLayer[]): ManifestObject[] {
    const lid: Record<string, number> = {};
    for (const l of layers) if (l.type === "objectgroup") lid[l.name] = l.id;
    return objects.slice().sort((a, b) => (lid[a.layer] ?? 0) - (lid[b.layer] ?? 0) || a.id - b.id);
}

const isInt = (v: unknown, min = 0, max = 0xffffffff): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isHex64 = (s: unknown): boolean => typeof s === "string" && /^[0-9a-f]{16}$/.test(s);

/** Parse and check a manifest. Throws {@link WorldError} on anything a v1 reader must refuse. */
export function parseManifest(text: string): Manifest {
    let m: Manifest;
    try {
        m = JSON.parse(text) as Manifest;
    } catch (e) {
        throw new WorldError(`manifest.json is not valid JSON (${(e as Error).message})`);
    }
    if (!m || m.format !== "ffworld") throw new WorldError('manifest.json is not a world manifest ("format" is not "ffworld")');
    if (m.formatVersion !== FORMAT_VERSION) throw new WorldError(`unsupported world format version ${m.formatVersion}`);
    if (typeof m.id !== "string" || !m.id) throw new WorldError("manifest id missing");
    if (!isHex64(m.generationId)) throw new WorldError("manifest generationId missing or malformed");
    const cs = m.chunkSize;
    if (!isInt(cs, 8, 256) || (cs & (cs - 1)) !== 0) throw new WorldError(`bad chunkSize ${cs}`);
    if (!isInt(m.width, 1) || !isInt(m.height, 1) || m.width % cs || m.height % cs) throw new WorldError("width/height must be positive multiples of chunkSize");
    if (!isInt(m.tilewidth, 1) || !isInt(m.tileheight, 1)) throw new WorldError("tilewidth/tileheight missing");
    if (m.chunksX !== m.width / cs || m.chunksY !== m.height / cs) throw new WorldError("chunksX/chunksY disagree with width/height");
    if (!isInt(m.packChunks, 1, 16)) throw new WorldError(`bad packChunks ${m.packChunks}`);
    if (m.packsX !== Math.ceil(m.chunksX / m.packChunks) || m.packsY !== Math.ceil(m.chunksY / m.packChunks)) throw new WorldError("packsX/packsY disagree");
    if (!isInt(m.worldRev)) throw new WorldError("worldRev missing");
    if (!Array.isArray(m.layers)) throw new WorldError("layers missing");
    const tl = tileLayers(m);
    if (tl.length > MAX_TILE_LAYERS) throw new WorldError("too many tile layers");
    tl.forEach((l, i) => {
        if (l.tileIndex !== i) throw new WorldError(`tile layer tileIndex values must be 0..n-1 (got ${l.tileIndex} at ${i})`);
        if (l.role !== "tiles" && l.role !== "collision" && l.role !== "nopvp") throw new WorldError(`bad role ${l.role} on layer ${l.name}`);
    });
    if (!Array.isArray(m.tilesets)) throw new WorldError("tilesets missing");
    if (!Array.isArray(m.packs) || m.packs.length !== m.packsX * m.packsY) throw new WorldError("packs list incomplete");
    m.packs.forEach((p, i) => {
        if (p.px !== i % m.packsX || p.py !== Math.floor(i / m.packsX)) throw new WorldError("packs must be listed row by row");
        if (!isHex64(p.packHash)) throw new WorldError("bad packHash");
        if (typeof p.file !== "string" || p.file.indexOf("..") >= 0 || /^([a-zA-Z]:)?[\\/]/.test(p.file)) throw new WorldError(`unsafe pack file name ${p.file}`);
    });
    for (const r of ["collision", "nopvp"] as const) {
        const b = m.bitsets?.[r];
        if (!b || typeof b.file !== "string" || b.file.indexOf("..") >= 0 || !isHex64(b.hash)) throw new WorldError(`bitset ${r} missing`);
    }
    if (!Array.isArray(m.objects)) throw new WorldError("objects missing");
    if (!isInt(m.nextObjectId)) throw new WorldError("nextObjectId missing");
    return m;
}

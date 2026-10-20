/**
 * Frostfire Forge world maps in Tiled.
 *
 * A `.world` directory is far too large to open whole (10240 x 10240 tiles per layer), so it is edited one region
 * at a time.
 *
 * - **File > Open World Map...** opens the whole world as a picture in its own tab, with the grid of regions on
 *   top. The "Pick World Region" tool is selected: click a region (or use the arrow keys) to select it, double-click
 *   (or press Enter) to open it. The tool bar switches between small, medium and large regions.
 * - A region opens as an ordinary finite map. **Map > Go to Region North / South / West / East** moves to the next
 *   one. Saving writes the edits back into the world's packs, bitsets and manifest.
 *
 * The `.worldmap` and `.region` files behind these tabs are created and reused in a folder next to Tiled's
 * extensions folder; the user never has to name or find them.
 */
import { WorldError, dirName, joinPath, normalizePath, relativePath, resolvePath } from "./lib/host";
import { DEFAULT_BACKGROUND, type TileColors, gridPixels, parseColor, renderPack, spawnPixels } from "./lib/preview";
import type { Manifest } from "./lib/manifest";
import {
    PROP_GENERATION,
    PROP_RECT,
    PROP_TILESET_DIR,
    PROP_WORLD,
    REGION_EXTENSION,
    type Rect,
    type RegionSnapshot,
    checkRect,
    findTilesetFile,
    gridCellAt,
    gridRect,
    gridSize,
    makeRegionFile,
    neighbourRect,
    parseRect,
    parseRegionFile,
    readManifest,
    regionTitle,
    regionToTiled,
    saveRegion,
    spawnTile,
    stringifyRegionFile,
} from "./lib/region";
import {
    DEFAULT_REGION_SIZE,
    REGION_SIZES,
    WORLDMAP_EXTENSION,
    cellPixels,
    highlightPixels,
    selectionPixels,
    parseWorldMapFile,
    regionSizesFor,
    stringifyWorldMapFile,
} from "./lib/worldmap";
import { tiledHost as host } from "./tiled-host";

const config = {
    name: "FrostfireWorld",
    title: "Frostfire World",
    debug: false,
};

// Tiled's `File` namespace; Bun's types declare a different global `File`
const TiledFile = File as unknown as {
    exists(path: string): boolean;
    makePath(path: string): boolean;
    directoryEntries(path: string): string[];
    lastModified(path: string): Date;
};

const PICKER_TOOL = `${config.name}_RegionPicker`;
const SELECTION_LAYER = "Selected region";
const KEY = { left: 0x01000012, up: 0x01000013, right: 0x01000014, down: 0x01000015, enter: 0x01000005, return: 0x01000004 };
const LEFT_BUTTON = 1;

interface WorldSettings {
    size: number;
    column: number;
    row: number;
    tilesetDir?: string;
}

interface Settings {
    lastWorld?: string;
    worlds: Record<string, WorldSettings>;
}

interface Cell {
    column: number;
    row: number;
}

/** An open world map tab. */
interface WorldMapState {
    worldDir: string;
    manifest: Manifest;
    size: number;
    cellPx: number;
    columns: number;
    rows: number;
    selection: Cell;
    hover: Cell | null;
    tilesetDir?: string;
}

interface OpenRegion {
    asset: Asset;
    worldDir: string;
    rect: Rect;
    tilesetDir?: string;
}

// What each open region held on disk when loaded or last saved, keyed by region file
const snapshots: Record<string, RegionSnapshot> = {};
// Open world maps, keyed by world map file
const world_maps: Record<string, WorldMapState> = {};
// Selection to show when a world map file is (re)loaded, keyed by world map file
const pending_selection: Record<string, Cell> = {};
// Highlight tilesets for the picker preview, keyed by cell size
const highlight_tilesets: Record<number, Tileset> = {};
let tool_before_picker: Tool | null = null;

const file_key = (fileName: string): string => normalizePath(fileName).toLowerCase();
const data_dir = (): string => joinPath(dirName(normalizePath(tiled.extensionsPath)), "frostfire-worlds");

/* ------------------------------------------------------------------------------------------------------------ */
/* Registration                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

tiled.registerMapFormat("region", {
    name: "Frostfire World Region",
    extension: REGION_EXTENSION,
    read: region_read,
    write: region_write,
});

tiled.registerMapFormat("worldmap", {
    name: "Frostfire World Map",
    extension: WORLDMAP_EXTENSION,
    read: worldmap_read,
    // Nothing on the world map is saved; a save keeps the file as it is
    write: () => undefined,
});

const action_open = tiled.registerAction(`${config.name}_OpenWorldMap`, () => guard(choose_world));
action_open.text = "Open World Map...";
action_open.shortcut = "Ctrl+Alt+O";

const action_open_selected = tiled.registerAction(`${config.name}_OpenSelectedRegion`, () => guard(open_selected_region));
action_open_selected.text = "Open Selected Region";

const directions = [
    { id: "North", dx: 0, dy: -1, key: "Up" },
    { id: "South", dx: 0, dy: 1, key: "Down" },
    { id: "West", dx: -1, dy: 0, key: "Left" },
    { id: "East", dx: 1, dy: 0, key: "Right" },
];
const move_actions = directions.map(d => {
    const action = tiled.registerAction(`${config.name}_Go${d.id}`, () => guard(() => move(d.dx, d.dy)));
    action.text = `Go to Region ${d.id}`;
    action.shortcut = `Alt+Shift+${d.key}`;
    return action;
});

const size_labels: Record<number, string> = { 256: "Small Regions (256 tiles)", 512: "Medium Regions (512 tiles)", 1024: "Large Regions (1024 tiles)" };
const size_actions = REGION_SIZES.map(size => {
    const action = tiled.registerAction(`${config.name}_Size${size}`, () => guard(() => switch_size(size)));
    action.text = size_labels[size] ?? `${size} Tile Regions`;
    action.checkable = true;
    return { size, action };
});

tiled.registerTool(PICKER_TOOL, {
    name: "Pick World Region",
    icon: "images/pick-region.png",
    toolBarActions: [...size_actions.map(s => `${config.name}_Size${s.size}`), `${config.name}_OpenSelectedRegion`],
    activated() {
        update_picker(this);
    },
    deactivated() {
        this.preview = new TileMap();
    },
    mouseMoved() {
        const state = picker_state(this);
        if (!state) return;
        const cell = cell_at(state, this.tilePosition);
        const changed = !state.hover || !cell || state.hover.column !== cell.column || state.hover.row !== cell.row;
        state.hover = cell;
        if (changed) update_picker(this);
    },
    mouseLeft() {
        const state = picker_state(this);
        if (!state) return;
        state.hover = null;
        update_picker(this);
    },
    mousePressed(button) {
        const state = picker_state(this);
        if (!state || button !== LEFT_BUTTON || !this.map) return;
        const cell = cell_at(state, this.tilePosition);
        if (!cell) return;
        set_selection(state, this.map, cell);
        update_picker(this);
    },
    mouseDoubleClicked(button) {
        const state = picker_state(this);
        if (!state || button !== LEFT_BUTTON || !this.map) return;
        const cell = cell_at(state, this.tilePosition);
        if (!cell) return;
        set_selection(state, this.map, cell);
        guard(() => open_cell(state));
    },
    keyPressed(key) {
        const state = picker_state(this);
        const map = this.map;
        if (!state || !map) return;
        sync_selection(state, map);
        if (key === KEY.enter || key === KEY.return) guard(() => open_cell(state));
        else if (key === KEY.left) move_selection(state, map, -1, 0);
        else if (key === KEY.right) move_selection(state, map, 1, 0);
        else if (key === KEY.up) move_selection(state, map, 0, -1);
        else if (key === KEY.down) move_selection(state, map, 0, 1);
        else return;
        update_picker(this);
    },
    mapChanged() {
        update_picker(this);
    },
    updateEnabledState() {
        this.enabled = !!picker_state(this);
    },
    updateStatusInfo() {
        update_picker(this);
    },
});

// There are no menus when Tiled runs a script from the command line
extend_menu("File", [
    { action: `${config.name}_OpenWorldMap`, before: "Save" },
    { separator: true },
]);
extend_menu("Map", [
    { separator: true },
    ...directions.map(d => ({ action: `${config.name}_Go${d.id}` })),
]);

tiled.activeAssetChanged.connect(asset => guard(() => asset_changed(asset)));
update_actions();

/* ------------------------------------------------------------------------------------------------------------ */
/* Regions: the map format                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

function region_read(fileName: string): TileMap {
    const region = parseRegionFile(host.readText(fileName));
    const region_dir = dirName(fileName);
    const world_dir = resolvePath(region_dir, region.world);
    const tileset_dir = region.tilesetDir ? resolvePath(region_dir, region.tilesetDir) : undefined;
    const manifest = readManifest(host, world_dir);
    const rect: Rect = { x: region.x, y: region.y, width: region.width, height: region.height };
    checkRect(manifest, rect);

    const started = Date.now();
    const { map, warnings, snapshot } = regionToTiled(host, world_dir, manifest, rect, tileset_dir);
    for (const warning of warnings) tiled.warn(`[${config.title}] ${warning}`, () => {});

    // Tiled's own JSON reader turns the map into a TileMap, keeping object ids and tileset data intact
    const temp = `${fileName}.load.tmp.json`;
    host.writeText(temp, JSON.stringify(map));
    let tile_map: TileMap;
    try {
        tile_map = json_format().read(temp);
    } finally {
        host.remove(temp);
    }

    snapshots[file_key(fileName)] = snapshot;
    debug(`Read ${regionTitle(manifest, rect)} in ${Date.now() - started}ms`);
    return tile_map;
}

function region_write(map: TileMap, fileName: string): string | undefined {
    try {
        const world_prop = map.property(PROP_WORLD);
        const rect_prop = map.property(PROP_RECT);
        const generation = map.property(PROP_GENERATION);
        if (typeof world_prop !== "string" || typeof rect_prop !== "string" || typeof generation !== "string" || !world_prop)
            return `This map is not a world region: it lacks the ${PROP_WORLD}, ${PROP_RECT} and ${PROP_GENERATION} properties. Open regions with File > Open World Map.`;
        const tileset_prop = map.property(PROP_TILESET_DIR);
        const world_dir = normalizePath(world_prop);
        const rect = parseRect(rect_prop);

        const started = Date.now();
        const temp = `${fileName}.save.tmp.json`;
        const error = json_format().write(map, temp);
        if (error) return error;
        let json;
        try {
            json = JSON.parse(host.readText(temp));
        } finally {
            host.remove(temp);
        }

        const key = file_key(fileName);
        const result = saveRegion(host, world_dir, rect, json, {
            generationId: generation,
            snapshot: snapshots[key],
            confirmStale: message => tiled.confirm(message, config.title),
        });
        snapshots[key] = result.snapshot;
        const tileset_dir = typeof tileset_prop === "string" && tileset_prop ? tileset_prop : undefined;
        write_if_changed(fileName, stringifyRegionFile(makeRegionFile(fileName, world_dir, rect, generation, tileset_dir)));

        if (result.written) {
            tiled.log(`[${config.title}] Saved ${result.changedChunks.length} chunk(s) in ${result.packsWritten} pack(s); objects: ` +
                `${result.objectsAdded} added, ${result.objectsUpdated} changed, ${result.objectsRemoved} removed (${Date.now() - started}ms).`);
        } else {
            tiled.log(`[${config.title}] No changes to save into the world.`);
        }
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The world map                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

function worldmap_read(fileName: string): TileMap {
    const file = parseWorldMapFile(host.readText(fileName));
    const dir = dirName(fileName);
    const world_dir = resolvePath(dir, file.world);
    const manifest = readManifest(host, world_dir);
    const size = file.size;
    const { columns, rows } = gridSize(manifest, size);
    const cell_px = cellPixels(manifest, size);
    const scale = size / cell_px;
    const tileset_dir = file.tilesetDir ? resolvePath(dir, file.tilesetDir) : undefined;
    const spawn = spawnTile(manifest);

    const map = new TileMap();
    map.setSize(columns, rows);
    map.setTileSize(cell_px, cell_px);
    const background = parseColor(manifest.backgroundcolor, DEFAULT_BACKGROUND);
    map.backgroundColor = `#${(background & 0xffffff).toString(16).padStart(6, "0")}`;
    map.addLayer(world_picture(fileName, world_dir, manifest, scale, tileset_dir, background));
    const width_px = Math.ceil(manifest.width / scale), height_px = Math.ceil(manifest.height / scale);
    map.addLayer(picture_layer("Grid", gridPixels(width_px, height_px, cell_px), width_px, height_px, 0, 0));
    map.addLayer(picture_layer("Spawn", spawnPixels(9), 9, 9, Math.floor(spawn.x / scale) - 4, Math.floor(spawn.y / scale) - 4));
    map.setProperty(PROP_WORLD, world_dir);
    map.setProperty("world.regionSize", size);

    const key = file_key(fileName);
    const selection = clamp_cell(pending_selection[key] ?? world_maps[key]?.selection ?? gridCellAt(manifest, size, spawn.x, spawn.y), columns, rows);
    delete pending_selection[key];

    // The selected region is a highlight in its own image layer, moved over the grid by its offset
    map.addLayer(picture_layer(SELECTION_LAYER, selectionPixels(cell_px), cell_px, cell_px, selection.column * cell_px, selection.row * cell_px));

    world_maps[key] = {
        worldDir: world_dir,
        manifest,
        size,
        cellPx: cell_px,
        columns,
        rows,
        selection,
        hover: null,
        tilesetDir: tileset_dir,
    };
    return map;
}

/** A locked image layer showing `pixels` at (x, y). */
function picture_layer(name: string, pixels: Uint32Array, width: number, height: number, x: number, y: number): ImageLayer {
    const layer = new ImageLayer(name);
    layer.setImage(new Image(pixels.buffer as ArrayBuffer, width, height, Image.Format_ARGB32 as unknown as number));
    layer.offset = Qt.point(x, y);
    layer.locked = true;
    return layer;
}

/**
 * The picture of the whole world: one image layer per pack, grouped. Each pack's picture is cached as a PNG named
 * after its pack hash, so only packs changed since the last time are drawn again.
 */
function world_picture(fileName: string, world_dir: string, manifest: Manifest, scale: number, tileset_dir: string | undefined, background: number): GroupLayer {
    const started = Date.now();
    const palette = tile_palette(world_dir, manifest, tileset_dir);
    const cache = joinPath(dirName(fileName), `picture ${scale} ${palette ? palette.key : "plain"}`);
    TiledFile.makePath(cache);
    const existing = TiledFile.directoryEntries(cache);
    const group = new GroupLayer("World");
    group.locked = true;
    const pack_tiles = manifest.packChunks * manifest.chunkSize;
    let drawn = 0;
    for (const pack of manifest.packs) {
        const prefix = `r${pack.px}_${pack.py}-`;
        const name = `${prefix}${pack.packHash}.png`;
        const path = joinPath(cache, name);
        if (existing.indexOf(name) < 0) {
            const picture = renderPack(host, world_dir, manifest, pack.px, pack.py, scale, palette ? palette.colors : null, background);
            const image = new Image(picture.pixels.buffer as ArrayBuffer, picture.width, picture.height, Image.Format_ARGB32 as unknown as number);
            if (!image.save(path)) throw new WorldError(`Could not write the world picture ${path}`);
            for (const old of existing) if (old.indexOf(prefix) === 0) host.remove(joinPath(cache, old));
            drawn++;
        }
        const layer = new ImageLayer(`Pack ${pack.px},${pack.py}`);
        layer.imageFileName = path;
        layer.offset = Qt.point((pack.px * pack_tiles) / scale, (pack.py * pack_tiles) / scale);
        group.addLayer(layer);
    }
    if (drawn) tiled.log(`[${config.title}] Drew ${drawn} of ${manifest.packs.length} part(s) of the ${manifest.id} world map in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    if (!palette) tiled.log(`[${config.title}] Tileset images of ${manifest.id} not found: the world map shows only open and blocked ground.`);
    return group;
}

const palettes: Record<string, { key: string; colors: TileColors }> = {};

/**
 * The average colour of every tile of the world's tilesets, from their images. Null when no image is found. The key
 * changes when a tileset image does, which redraws the cached pictures.
 */
function tile_palette(world_dir: string, manifest: Manifest, tileset_dir: string | undefined): { key: string; colors: TileColors } | null {
    const sources: { entry: Record<string, unknown>; path: string }[] = [];
    for (const entry of manifest.tilesets) {
        if (typeof entry.image !== "string") continue;
        const path = findTilesetFile(host, world_dir, entry.image, tileset_dir);
        if (path) sources.push({ entry, path });
    }
    if (!sources.length) return null;
    const key = path_hash(sources.map(s => `${s.path}|${Number(s.entry.firstgid)}|${TiledFile.lastModified(s.path).getTime()}`).join(";"));
    if (palettes[key]) return palettes[key]!;

    let max_gid = 0;
    for (const { entry } of sources) max_gid = Math.max(max_gid, Number(entry.firstgid) + Number(entry.tilecount ?? 0));
    const colors = new Uint32Array(max_gid + 1);
    for (const { entry, path } of sources) {
        const image = new Image(path);
        const tw = Number(entry.tilewidth), th = Number(entry.tileheight);
        const spacing = Number(entry.spacing ?? 0), margin = Number(entry.margin ?? 0);
        const columns = Number(entry.columns) || Math.floor((image.width - 2 * margin + spacing) / (tw + spacing));
        const count = Number(entry.tilecount) || columns * Math.floor((image.height - 2 * margin + spacing) / (th + spacing));
        if (!(tw > 0 && th > 0 && columns > 0 && count > 0)) continue;
        const rows = Math.ceil(count / columns);
        const first = Number(entry.firstgid);
        const tile_color = (small: Image, x: number, y: number): number => unpremultiply(small.pixel(x, y) >>> 0, small.format);
        if (spacing === 0 && margin === 0) {
            // Smooth scaling to one pixel per tile averages each tile's pixels
            const small = image.copy(0, 0, columns * tw, rows * th).scaled(columns, rows, Image.IgnoreAspectRatio, Image.SmoothTransformation);
            for (let id = 0; id < count; id++) colors[first + id] = tile_color(small, id % columns, Math.floor(id / columns));
        } else {
            for (let id = 0; id < count; id++) {
                const x = margin + (id % columns) * (tw + spacing), y = margin + Math.floor(id / columns) * (th + spacing);
                colors[first + id] = tile_color(image.copy(x, y, tw, th).scaled(1, 1, Image.IgnoreAspectRatio, Image.SmoothTransformation), 0, 0);
            }
        }
    }
    palettes[key] = { key, colors };
    return palettes[key]!;
}

/** `pixel()` of a premultiplied image returns premultiplied colour; the pictures blend straight colour. */
function unpremultiply(argb: number, format: number): number {
    if (format !== (Image.Format_ARGB32_Premultiplied as unknown as number)) return argb;
    const a = argb >>> 24;
    if (a === 0 || a === 255) return argb;
    const f = (v: number) => Math.min(255, Math.round((v * 255) / a));
    return ((a << 24) | (f((argb >>> 16) & 255) << 16) | (f((argb >>> 8) & 255) << 8) | f(argb & 255)) >>> 0;
}

/**
 * Open the world map of a world and select a region: the active region when it is in that world, the last region
 * picked in that world, or the spawn point.
 */
function open_world_map(world_dir: string, size_override?: number): void {
    const settings = load_settings();
    const region = current_region();
    const map_state = current_world_map();

    const manifest = readManifest(host, world_dir);
    const sizes = regionSizesFor(manifest);
    const remembered = settings.worlds[world_dir];
    let size = size_override ?? (region ? Math.max(region.rect.width, region.rect.height) : remembered?.size ?? DEFAULT_REGION_SIZE);
    if (sizes.indexOf(size) < 0) size = sizes.indexOf(DEFAULT_REGION_SIZE) >= 0 ? DEFAULT_REGION_SIZE : sizes[0]!;

    let cell: Cell;
    if (region && region.worldDir === world_dir) cell = gridCellAt(manifest, size, region.rect.x, region.rect.y);
    else if (map_state && map_state.worldDir === world_dir) {
        const r = gridRect(manifest, map_state.size, map_state.selection.column, map_state.selection.row);
        cell = gridCellAt(manifest, size, r.x + r.width / 2, r.y + r.height / 2);
    } else if (remembered && remembered.size === size) cell = { column: remembered.column, row: remembered.row };
    else cell = gridCellAt(manifest, size, spawnTile(manifest).x, spawnTile(manifest).y);

    const tileset_dir = ensure_tileset_dir(world_dir, manifest, settings);
    const path = joinPath(world_folder(world_dir, manifest), `${safe_name(manifest.id)} - world map (${size}).${WORLDMAP_EXTENSION}`);
    TiledFile.makePath(dirName(path));
    write_if_changed(path, stringifyWorldMapFile({
        format: "worldmap",
        version: 1,
        world: relativePath(dirName(path), world_dir),
        size,
        tilesetDir: tileset_dir ? relativePath(dirName(path), tileset_dir) : undefined,
    }));

    const key = file_key(path);
    pending_selection[key] = cell;

    settings.lastWorld = world_dir;
    settings.worlds[world_dir] = { ...(settings.worlds[world_dir] ?? { column: 0, row: 0 }), size, column: cell.column, row: cell.row, tilesetDir: tileset_dir };
    save_settings(settings);

    const previous = tiled.activeAsset;
    const opened = tiled.open(path);
    // A world map that was already open is not read again: move its selection here
    if (pending_selection[key]) {
        delete pending_selection[key];
        const state = world_maps[key];
        if (state && opened && opened.isTileMap) set_selection(state, opened as TileMap, cell);
    }
    // Switching sizes replaces the world map tab
    if (size_override !== undefined && previous && previous !== tiled.activeAsset && is_world_map(previous)) tiled.close(previous);
    select_picker();
}

/** File > Open World Map: ask for the world, starting at the world of the active tab or the last one used. */
function choose_world(): void {
    const start = current_region()?.worldDir ?? current_world_map()?.worldDir ?? load_settings().lastWorld ?? "";
    const world_dir = prompt_world(start);
    if (world_dir) open_world_map(world_dir);
}

function switch_size(size: number): void {
    const state = current_world_map();
    if (!state) {
        update_actions();
        return;
    }
    if (state.size !== size) open_world_map(state.worldDir, size);
    update_actions();
}

function open_selected_region(): void {
    const state = current_world_map();
    if (!state) {
        tiled.alert("Open a world map first (File > Open World Map...).", config.title);
        return;
    }
    sync_selection(state, tiled.activeAsset as TileMap);
    open_cell(state);
}

/** Open the selected region of a world map. */
function open_cell(state: WorldMapState): void {
    const rect = gridRect(state.manifest, state.size, state.selection.column, state.selection.row);
    remember_selection(state);
    open_region_at(state.worldDir, state.manifest, rect, state.tilesetDir);
}

function move_selection(state: WorldMapState, map: TileMap, dx: number, dy: number): void {
    sync_selection(state, map);
    set_selection(state, map, { column: state.selection.column + dx, row: state.selection.row + dy });
}

function selection_layer(map: TileMap): ImageLayer | null {
    for (const layer of map.layers) if (layer.isImageLayer && layer.name === SELECTION_LAYER) return layer as ImageLayer;
    return null;
}

/** Take the selection from the frame layer, which undo may have moved. */
function sync_selection(state: WorldMapState, map: TileMap): void {
    const layer = selection_layer(map);
    if (!layer) return;
    state.selection = clamp_cell({ column: Math.round(layer.offset.x / state.cellPx), row: Math.round(layer.offset.y / state.cellPx) }, state.columns, state.rows);
}

/** Select a region: move the frame layer over it and remember it. */
function set_selection(state: WorldMapState, map: TileMap, cell: Cell): void {
    state.selection = clamp_cell(cell, state.columns, state.rows);
    const layer = selection_layer(map);
    if (layer) {
        const x = state.selection.column * state.cellPx, y = state.selection.row * state.cellPx;
        if (layer.offset.x !== x || layer.offset.y !== y) layer.offset = Qt.point(x, y);
    }
    remember_selection(state);
    // Nothing on the world map is saved; saving here keeps Tiled from asking about unsaved changes on close
    if (map.modified) map.save();
}

function remember_selection(state: WorldMapState): void {
    const settings = load_settings();
    settings.lastWorld = state.worldDir;
    settings.worlds[state.worldDir] = { ...(settings.worlds[state.worldDir] ?? {}), size: state.size, column: state.selection.column, row: state.selection.row, tilesetDir: state.tilesetDir };
    save_settings(settings);
}

/** The world map state of the tool's map, if it is a world map. */
function picker_state(tool: Tool): WorldMapState | null {
    const map = tool.map;
    if (!map || !/\.worldmap$/i.test(map.fileName)) return null;
    return world_maps[file_key(map.fileName)] ?? null;
}

function cell_at(state: WorldMapState, position: point): Cell | null {
    const column = Math.floor(position.x), row = Math.floor(position.y);
    if (column < 0 || row < 0 || column >= state.columns || row >= state.rows) return null;
    return { column, row };
}

/** Draw the hover outline and the selection, and describe the selection in the status bar. */
function update_picker(tool: Tool): void {
    const state = picker_state(tool);
    if (!state) {
        tool.statusInfo = "";
        return;
    }
    const preview = new TileMap();
    preview.setSize(state.columns, state.rows);
    preview.setTileSize(state.cellPx, state.cellPx);
    const tileset = highlight_tileset(state.cellPx);
    const layer = new TileLayer("Highlight");
    layer.width = state.columns;
    layer.height = state.rows;
    preview.addLayer(layer);
    preview.addTileset(tileset);
    // The selection is drawn by its own layer; the preview only outlines the region under the mouse
    if (tool.map) sync_selection(state, tool.map);
    const edit = layer.edit();
    if (state.hover && (state.hover.column !== state.selection.column || state.hover.row !== state.selection.row))
        edit.setTile(state.hover.column, state.hover.row, tileset.tile(0));
    edit.apply();
    tool.preview = preview;

    const rect = gridRect(state.manifest, state.size, state.selection.column, state.selection.row);
    tool.statusInfo = `Region column ${state.selection.column + 1}, row ${state.selection.row + 1} of ${state.columns} x ${state.rows} ` +
        `(tiles ${rect.x}-${rect.x + rect.width - 1}, ${rect.y}-${rect.y + rect.height - 1}). Click or use the arrow keys to select, double-click or press Enter to open.`;
}

function highlight_tileset(cell: number): Tileset {
    if (!highlight_tilesets[cell]) {
        const tileset = new Tileset("Region highlight");
        tileset.setTileSize(cell, cell);
        const pixels = highlightPixels(cell);
        tileset.loadFromImage(new Image(pixels.buffer as ArrayBuffer, cell * 2, cell, Image.Format_ARGB32 as unknown as number));
        highlight_tilesets[cell] = tileset;
    }
    return highlight_tilesets[cell]!;
}

/** Select the picker tool, remembering the tool it replaces. */
function select_picker(): void {
    const editor = tiled.mapEditor;
    if (!editor) return;
    try {
        const picker = editor.tool(PICKER_TOOL);
        if (!picker || editor.selectedTool === picker) return;
        tool_before_picker = editor.selectedTool;
        editor.selectedTool = picker;
    } catch (error) {
        debug(`Could not select the picker tool: ${error}`);
    }
}

/** Give back the tool the picker replaced. */
function restore_tool(): void {
    const editor = tiled.mapEditor;
    if (!editor) return;
    try {
        const picker = editor.tool(PICKER_TOOL);
        if (editor.selectedTool === picker) editor.selectedTool = tool_before_picker ?? editor.tool("StampTool");
    } catch (error) {
        debug(`Could not restore the tool: ${error}`);
    }
}

function asset_changed(asset: Asset | null): void {
    if (asset && is_world_map(asset)) select_picker();
    else if (asset && asset.isTileMap) restore_tool();
    update_actions();
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Regions: opening and moving                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** Open (or switch to) the region `rect` of a world. */
function open_region_at(world_dir: string, manifest: Manifest, rect: Rect, tileset_dir: string | undefined): void {
    checkRect(manifest, rect);
    const dir = world_folder(world_dir, manifest);
    TiledFile.makePath(dir);
    const path = joinPath(dir, `${regionTitle(manifest, rect)}.${REGION_EXTENSION}`);
    write_if_changed(path, stringifyRegionFile(makeRegionFile(path, world_dir, rect, manifest.generationId, tileset_dir)));
    tiled.open(path);
}

/** Arrow actions: move the selection on a world map, or move to the next region from a region. */
function move(dx: number, dy: number): void {
    const state = current_world_map();
    if (state) {
        move_selection(state, tiled.activeAsset as TileMap, dx, dy);
        const editor = tiled.mapEditor;
        if (editor && editor.selectedTool) update_picker(editor.selectedTool);
        return;
    }
    const current = current_region();
    if (!current) {
        tiled.alert("Open a world first (File > Open World Map...).", config.title);
        return;
    }
    const manifest = readManifest(host, current.worldDir);
    const next = neighbourRect(manifest, current.rect, dx, dy);
    if (!next) {
        tiled.alert("This region is at the edge of the world.", config.title);
        return;
    }
    if (current.asset.modified && tiled.confirm("Save your changes to this region before moving on?\n\nIf you choose No, the region stays open with your changes.", config.title)) {
        if (!current.asset.save()) return;
    }
    open_region_at(current.worldDir, manifest, next, current.tilesetDir);
    if (!current.asset.modified) tiled.close(current.asset);
}

/** The region in the active tab, if it is one. */
function current_region(): OpenRegion | null {
    const asset = tiled.activeAsset;
    if (!asset || !asset.isTileMap || !/\.region$/i.test(asset.fileName)) return null;
    const map = asset as TileMap;
    const world = map.property(PROP_WORLD);
    const rect = map.property(PROP_RECT);
    if (typeof world !== "string" || typeof rect !== "string" || !world) return null;
    const tileset_dir = map.property(PROP_TILESET_DIR);
    return {
        asset,
        worldDir: normalizePath(world),
        rect: parseRect(rect),
        tilesetDir: typeof tileset_dir === "string" && tileset_dir ? tileset_dir : undefined,
    };
}

/** The world map in the active tab, if it is one. */
function current_world_map(): WorldMapState | null {
    const asset = tiled.activeAsset;
    if (!asset || !is_world_map(asset)) return null;
    return world_maps[file_key(asset.fileName)] ?? null;
}

const is_world_map = (asset: Asset): boolean => asset.isTileMap && /\.worldmap$/i.test(asset.fileName);

function update_actions(): void {
    const region = current_region();
    const state = current_world_map();
    for (const action of move_actions) action.enabled = !!region || !!state;
    action_open_selected.enabled = !!state;
    for (const { size, action } of size_actions) {
        action.enabled = !!state && regionSizesFor(state.manifest).indexOf(size) >= 0;
        action.checked = !!state && state.size === size;
    }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Helpers                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/** Ask for a `.world` folder. */
function prompt_world(start_dir: string): string | null {
    const picked = tiled.promptDirectory(start_dir, "Choose a world: the folder whose name ends in .world");
    if (!picked) return null;
    const dir = normalizePath(picked);
    if (host.exists(joinPath(dir, "manifest.json"))) return dir;
    tiled.alert(`"${dir}" is not a world.\n\nChoose the folder whose name ends in .world. It holds manifest.json, collision.bits and a packs folder.`, config.title);
    return null;
}

/**
 * The folder with the world's tileset images, when they are not next to the world: asked for once and remembered.
 * Returns undefined when the images are found without one, or the user skips the question.
 */
function ensure_tileset_dir(world_dir: string, manifest: Manifest, settings: Settings): string | undefined {
    const remembered = settings.worlds[world_dir]?.tilesetDir;
    const missing = (dir?: string) => manifest.tilesets
        .map(ts => (typeof ts.image === "string" ? ts.image : typeof ts.source === "string" ? ts.source : null))
        .filter((path): path is string => path !== null && !findTilesetFile(host, world_dir, path, dir));
    if (!missing(remembered).length) return remembered;
    const names = missing(remembered).join(", ");
    if (!tiled.confirm(`The tileset images of ${manifest.id} (${names}) were not found next to the world.\n\nChoose the folder that holds them? Without them, regions show empty tiles.`, config.title))
        return remembered;
    const picked = tiled.promptDirectory(dirName(world_dir), "Choose the folder that holds the tileset images");
    return picked ? normalizePath(picked) : remembered;
}

/** The folder that holds the world map and region files of a world. */
const world_folder = (world_dir: string, manifest: Manifest): string => joinPath(data_dir(), `${safe_name(manifest.id)}-${path_hash(world_dir)}`);

const safe_name = (s: string): string => s.replace(/[\\/:*?"<>|]/g, "_");

const clamp_cell = (cell: Cell, columns: number, rows: number): Cell => ({
    column: Math.max(0, Math.min(columns - 1, cell.column)),
    row: Math.max(0, Math.min(rows - 1, cell.row)),
});

function load_settings(): Settings {
    try {
        const path = joinPath(data_dir(), "settings.json");
        if (host.exists(path)) {
            const s = JSON.parse(host.readText(path));
            return { lastWorld: s.lastWorld, worlds: s.worlds ?? {} };
        }
    } catch (error) {
        debug(`Could not read the settings: ${error}`);
    }
    return { worlds: {} };
}

function save_settings(settings: Settings): void {
    try {
        TiledFile.makePath(data_dir());
        host.writeText(joinPath(data_dir(), "settings.json"), JSON.stringify(settings, null, 2));
    } catch (error) {
        debug(`Could not save the settings: ${error}`);
    }
}

/** Write a text file only when its content changes, so Tiled does not see an open file change. */
function write_if_changed(path: string, text: string): void {
    if (host.exists(path) && host.readText(path) === text) return;
    host.writeText(path, text);
}

/** A short hash of a path (FNV-1a), to keep two copies of a world apart. */
function path_hash(path: string): string {
    let h = 0x811c9dc5;
    const s = path.toLowerCase();
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16);
}

function extend_menu(menu: string, items: MenuItem[]): void {
    try {
        tiled.extendMenu(menu, items);
    } catch (error) {
        debug(`Could not extend the ${menu} menu: ${error}`);
    }
}

function guard(fn: () => void): void {
    try {
        fn();
    } catch (error) {
        tiled.alert(error instanceof WorldError || error instanceof Error ? error.message : String(error), config.title);
    }
}

function json_format(): MapFormat {
    const format = tiled.mapFormat("json");
    if (!format) throw new WorldError("Tiled's JSON map format is not available");
    return format;
}

// Debug logging
function debug(message: string) {
    if (config.debug) {
        tiled.log(`[DEBUG]: ${message}`);
    }
}

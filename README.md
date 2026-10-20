# Frostfire Worlds for Tiled

A [Tiled Map Editor](https://www.mapeditor.org/) extension that opens Frostfire Forge `.world` maps and saves edits back into them.

A world is far too large to open whole: a 10240 x 10240 world holds over 100 million tiles per layer. The extension therefore edits a world one **region** at a time. A region is a rectangle of tiles that Tiled shows as an ordinary finite map. Saving the region writes the changed chunks back into the world's packs, collision and no-PvP bitsets, and manifest.

## Installation

1. Build the extension (see [Development](#development)) or download `frostfire-worlds.zip` from a release.
2. Copy the `frostfire-worlds` folder into Tiled's extensions directory.

| Platform | Extensions Directory |
|----------|---------------------|
| Windows  | `%USERPROFILE%/AppData/Local/Tiled/extensions/` |
| macOS    | `~/Library/Preferences/Tiled/extensions/` |
| Linux    | `~/.config/tiled/extensions/` |

> You can also open the directory from Tiled: **Edit > Preferences > Plugins > Open** (Extensions section).

Requires Tiled 1.12 or newer (the world map selects its tool through `tiled.mapEditor.selectedTool`). Tested with Tiled 1.12.2.

## Usage

### Open the world map

1. Choose **File > Open World Map...** (Ctrl+Alt+O).
2. Choose the world: the folder whose name ends in `.world`. The folder picker starts at the world you used last, so reopening it is one click.
3. If the world's tileset images are not next to it, Tiled asks once for the folder that holds them and remembers it.

The world opens in a tab such as `overworld - world map (512)`: a picture of the whole world with the grid of regions on top and a red dot at the spawn point. You can zoom and scroll it like any map.

The picture is drawn from the world's own tiles, each in the average colour of its tileset image, so ground, water, snow, roads and towns show as they look in game (one pixel covers 8 x 8 tiles on a 10240 x 10240 world). The first time a world is opened this takes a few seconds (about 10 for 10240 x 10240); the picture is cached per pack file, so later opens are quick and after a save only the changed parts are drawn again. Without the tileset images the picture shows only open (light) and blocked (dark) ground.

### Pick a region

The **Pick World Region** tool is selected when the world map opens (its icon is a green grid with a yellow square).

| To | Do |
|----|----|
| Select a region | Click it, or move the yellow selection with the arrow keys |
| Open the selected region | Double-click it, press Enter, or click **Open Selected Region** in the tool bar |
| Change the region size | Click **Small**, **Medium** or **Large Regions** in the tool bar (256, 512 or 1024 tiles) |

A white outline follows the mouse. The status bar shows the selected region's column, row and tiles. If the arrow keys scroll the view instead, use Alt+Shift+arrow keys.

The region opens in its own tab, for example `overworld - 512 - column 11, row 12`. The world map stays open in its tab, so you can go back and pick another region. The world map remembers the last region you picked.

### Move to the next region

In a region, use **Map > Go to Region North / South / West / East**, or Alt+Shift+Up / Down / Left / Right. If the region you are leaving has unsaved changes, Tiled asks whether to save them first; if you choose No, it stays open in its tab.

**File > Open World Map...** from a region shows the world map with that region selected.

### Edit and save

Edit tiles and objects as in any map, then save with **File > Save** (Ctrl+S). The Console (**View > Views and Toolbars > Console**) reports what was written:

```text
[Frostfire World] Saved 3 chunk(s) in 1 pack(s); objects: 1 added, 0 changed, 0 removed (412ms).
```

A save with no changes writes nothing.

| You can | You cannot |
|---------|------------|
| Paint and erase tiles on every tile layer, including `Collisions` and `nopvpzone` | Resize the region or make the map infinite |
| Add, move, edit and delete objects (warps, graveyards, particles, ...) | Add, remove or rename layers; layers missing from the map are left alone |
| Use tiles from every tileset of the world, in any order | Add a tileset the world does not have |

Changes to layer visibility, lock state and layer properties are not saved into the world.

### What a save does

1. Every chunk that overlaps the region is decoded, the region's tiles are copied in, and a chunk whose tiles changed is re-encoded with its `chunkRev` raised by one.
2. Each pack file that holds a changed chunk is rebuilt. Unchanged chunk records are copied byte for byte.
3. The collision and no-PvP bitset blocks of the changed chunks are rebuilt from the layers with role `collision` and `nopvp`.
4. The objects of the region (those whose position lies inside it, on the object layers the map has) are replaced by the map's objects. Objects outside the region are kept. Object ids are kept; new objects get new ids from `nextObjectId`.
5. Files are written packs first, then bitsets, then `manifest.json` with `worldRev` raised by one. Each file is replaced atomically. If Tiled stops between files, the asset server repairs the world at its next start, as it does for an interrupted editor save.

The output matches the format of the map generator and the asset server, including the canonical chunk encoding and manifest text.

### Safety checks

- **Regenerated world.** The region remembers the world's `generationId`. If the world was generated again, the save is refused. Open the region again.
- **Someone else changed the same area.** When a save from another tab, another person or the in-game editor changed tiles or objects inside your region after you opened it, Tiled asks before overwriting them. Saves elsewhere in the world never ask.

### Working with a live asset server

You can save into the world folder of a running asset server. The asset server notices when a world's `manifest.json` or a pack file changed on disk: it reads them again before it serves chunks or saves edits from the game, and logs `World <id>.json changed on disk: read again`. It also bakes the world's map image (the game's full-map view) again, drawing only the chunks of the changed packs, about a quarter of a second per pack on a 10240 x 10240 world. This needs the asset server version from 2026-10-20 or later. Older asset servers keep serving the old pack layout (logging `Error serving map chunk: incorrect header check`), and their next in-game save of warps or graveyards overwrites the manifest, which is later reported as `a save had been cut short`; with those, stop the asset server while you save.

The game servers keep their own copy of the collision and no-PvP data. Game servers from 2026-10-20 or later check the asset server every 10 seconds (`WORLD_SYNC_INTERVAL` in seconds, `0` to turn it off) and take in a changed world without a restart: new collision and no-PvP data, warps and graveyards, and a new map version. Players see the new tiles after they reload the page. Particle NPCs and a change of world size still need a restart. Older game servers pick up a save at their next start.

## The `.region` file

You do not need to handle these files. Each region is backed by a small JSON file that names the world and the rectangle, and each world map by a `.worldmap` file and its picture (`.png`). The extension creates and reuses them in `frostfire-worlds/` next to Tiled's extensions folder (on Windows `%USERPROFILE%/AppData/Local/Tiled/frostfire-worlds/`), together with `settings.json`, which remembers the last world and region. Recent regions also show up in **File > Recent Files**. Paths in the file are relative to it.

```json
{
  "format": "region",
  "version": 1,
  "world": "../maps/overworld.world",
  "x": 4928,
  "y": 5568,
  "width": 512,
  "height": 512,
  "generationId": "3aee7f92f4a3409f",
  "tilesetDir": "../tilesets"
}
```

`tilesetDir` is optional. Tileset images are looked up in this order: the path in the manifest relative to the world folder, the same path relative to the folder that holds the world, `tilesetDir/<file name>`, then `tilesets/<file name>` in the world folder and up to four folders above it.

The opened map also carries the region in the map properties `world.folder`, `world.region`, `world.generationId` and `world.tilesetFolder`. **Save As** to a new `.region` file uses them. Do not edit them.

## Development

Written in TypeScript. Requires [Bun](https://bun.sh/).

```sh
bun install
```

### Build

```sh
bun run build
```

The output lands in `dist/frostfire-worlds/index.mjs`: one file, bundled with Bun and downlevelled with the TypeScript compiler, because Qt's script engine does not support every recent syntax feature. Copy the `frostfire-worlds` folder into Tiled's extensions directory.

### Tests

```sh
bun test
```

The tests use the golden world fixture from the map generator (`tests/fixtures/world`). When the Map Generation project is present at `F:/Projects/Map Generation`, one test also checks a saved region with the generator's own `verifyWorld`.

### Layout

| File | Purpose |
|------|---------|
| `src/index.ts` | Tiled entry: the `region` and `worldmap` formats, the Pick World Region tool and the navigation actions |
| `src/lib/preview.ts`, `worldmap.ts` | The world map picture (tile colours, per pack), its grid and the region highlight |
| `src/tiled-host.ts` | File and compression access through Tiled's API |
| `src/lib/region.ts` | Reading a region into a Tiled JSON map and saving an edited one back |
| `src/lib/chunk.ts`, `pack.ts`, `bitset.ts`, `manifest.ts` | The world file format (`"format": "ffworld"` v1, as the engine and asset server name it) |
| `src/lib/xxh64.ts` | xxHash64 without BigInt (Qt's script engine has none) |

### Debug Logging

Set `config.debug` to `true` in `src/index.ts` to log read timings to Tiled's console. Set it back to `false` before building a release.

## License

Copyright (c) Frostfire Interactive. Free for noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE), the same license as Frostfire Forge.

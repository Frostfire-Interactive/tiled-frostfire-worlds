# Changelog

## [1.0.0] - 2026-10-19

### Added
- `region` map format: opens a region of a Frostfire Forge `.world` map as a finite Tiled map and saves edits back into the world's packs, bitsets and manifest
- **File > Open World Map...** (Ctrl+Alt+O): the whole world as a zoomable map tab with a grid of regions, drawn in the colours of its tiles and cached per pack. Click or use the arrow keys to select a region, double-click or press Enter to open it; switch between small, medium and large regions in the tool bar. The last world, region and tileset folder are remembered
- **Map > Go to Region North / South / West / East** (Alt+Shift+arrow keys) to move to the next region, offering to save the current one first
- Region files are created and reused automatically; no file names to choose
- Saving refuses a regenerated world, and asks only when someone else changed tiles or objects inside the same region

import ts from "typescript";
import { readdir } from "node:fs/promises";

performance.mark("start-build");

const output_location = `./dist/frostfire-worlds/`;

// Bundle every module into one file. Tiled loads `index.mjs` from the
// extension folder, so a single file keeps the install a plain copy.
const bundle = await Bun.build({
    entrypoints: [`./src/index.ts`],
    target: "browser",
    format: "esm",
    minify: false,
});

if (!bundle.success || !bundle.outputs[0]) {
    for (const message of bundle.logs) console.error(message);
    throw new Error("Failed to bundle project");
}

// Downlevel with the TypeScript compiler. Qt's QJSEngine does not support
// class fields and other post-ES2021 syntax that Bun emits as-is.
const transpiled = ts.transpileModule(await bundle.outputs[0].text(), {
    fileName: "index.js",
    compilerOptions: {
        target: ts.ScriptTarget.ES2017,
        module: ts.ModuleKind.ESNext,
        allowJs: true,
    },
}).outputText;

await Bun.write(`${output_location}index.mjs`, transpiled);

// Copy images (tool icons) next to the script
const image_location = `./src/images`;
for (const file of await readdir(image_location)) {
    await Bun.write(`${output_location}images/${file}`, Bun.file(`${image_location}/${file}`));
}

// The license travels with every copy, as its terms require
await Bun.write(`${output_location}LICENSE`, Bun.file(`./LICENSE`));

performance.mark("end-build");
console.log(`Build completed in ${performance.measure("build", "start-build", "end-build").duration.toFixed(2)}ms`);

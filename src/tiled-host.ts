/**
 * {@link Host} backed by Tiled's scripting API. `BinaryFile` and `TextFile` write through QSaveFile, so a write
 * only replaces the file on `commit()`.
 */
import { type Compression, type Host, WorldError } from "./lib/host";

// Tiled's `File` namespace; Bun's types declare a different global `File`
const TiledFile = File as unknown as { exists(path: string): boolean; remove(path: string): boolean };

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data.buffer as ArrayBuffer;
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

const methods: Record<Compression, Tiled.CompressionMethod> = {
    zlib: Tiled.Zlib,
    gzip: Tiled.Gzip,
    zstd: Tiled.Zstandard,
};

export const tiledHost: Host = {
    exists: path => TiledFile.exists(path),

    readText(path) {
        const file = new TextFile(path, TextFile.ReadOnly);
        try {
            return file.readAll();
        } finally {
            file.close();
        }
    },

    writeText(path, text) {
        const file = new TextFile(path, TextFile.WriteOnly);
        file.write(text);
        file.commit();
    },

    readBytes(path) {
        const file = new BinaryFile(path, BinaryFile.ReadOnly);
        try {
            return new Uint8Array(file.readAll());
        } finally {
            file.close();
        }
    },

    readRanges(path, ranges) {
        const file = new BinaryFile(path, BinaryFile.ReadOnly);
        try {
            return ranges.map(r => {
                file.seek(r.offset);
                return new Uint8Array(file.read(r.length));
            });
        } finally {
            file.close();
        }
    },

    writeBytes(path, data) {
        const file = new BinaryFile(path, BinaryFile.WriteOnly);
        file.write(toArrayBuffer(data));
        file.commit();
    },

    remove(path) {
        if (TiledFile.exists(path)) TiledFile.remove(path);
    },

    deflate: data => new Uint8Array(tiled.compress(toArrayBuffer(data), Tiled.Zlib, 6)),

    decompress(data, method) {
        const out = new Uint8Array(tiled.decompress(toArrayBuffer(data), methods[method]));
        if (data.byteLength > 0 && out.byteLength === 0) throw new WorldError(`corrupt ${method} data`);
        return out;
    },

    base64Encode: data => Base64.encode(toArrayBuffer(data)),
    base64Decode: text => new Uint8Array(Base64.decode(text)),
};

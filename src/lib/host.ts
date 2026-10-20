/**
 * Everything the world code needs from its surroundings. Inside Tiled this is backed by `BinaryFile`, `TextFile`,
 * `tiled.compress` and `Base64` (see `src/tiled-host.ts`); the tests back it with `node:fs` and `node:zlib`.
 */
export type Compression = "zlib" | "gzip" | "zstd";

export interface ByteRange {
    offset: number;
    length: number;
}

export interface Host {
    exists(path: string): boolean;
    readText(path: string): string;
    /** Write a whole file. Must be atomic: a failed write leaves the old file in place. */
    writeText(path: string, text: string): void;
    readBytes(path: string): Uint8Array;
    /** Read several byte ranges of one file with a single open. */
    readRanges(path: string, ranges: ByteRange[]): Uint8Array[];
    /** Write a whole file. Must be atomic: a failed write leaves the old file in place. */
    writeBytes(path: string, data: Uint8Array): void;
    remove(path: string): void;
    /** zlib (RFC 1950) at level 6, the codec of chunk records. */
    deflate(data: Uint8Array): Uint8Array;
    decompress(data: Uint8Array, method: Compression): Uint8Array;
    base64Encode(data: Uint8Array): string;
    base64Decode(text: string): Uint8Array;
}

/** Thrown for anything wrong with a world or a region. The message is shown to the user as is. */
export class WorldError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorldError";
    }
}

/** Join path segments with "/". */
export function joinPath(...parts: string[]): string {
    return parts
        .filter(p => p !== "")
        .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
        .join("/");
}

/** The directory part of a path, without a trailing separator. */
export function dirName(path: string): string {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return i < 0 ? "." : path.slice(0, i);
}

/** The file name part of a path. */
export function baseName(path: string): string {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return path.slice(i + 1);
}

/** True for "/x", "\\x" and "C:\x" style paths. */
export const isAbsolute = (path: string): boolean => /^([a-zA-Z]:)?[\\/]/.test(path);

/** Resolve "." and ".." segments and use "/" throughout. */
export function normalizePath(path: string): string {
    const parts = path.replace(/\\/g, "/").split("/");
    const out: string[] = [];
    for (const part of parts) {
        if (part === "." || (part === "" && out.length > 0)) continue;
        if (part === ".." && out.length > 0 && out[out.length - 1] !== ".." && !/^[a-zA-Z]:$/.test(out[out.length - 1]!) && out[out.length - 1] !== "") out.pop();
        else out.push(part);
    }
    return out.join("/") || ".";
}

/** Resolve `path` against `base` unless it is absolute. */
export const resolvePath = (base: string, path: string): string => normalizePath(isAbsolute(path) ? path : joinPath(base, path));

/** A path from directory `from` to `to`, or `to` itself when they share no root. */
export function relativePath(from: string, to: string): string {
    const a = normalizePath(from).split("/");
    const b = normalizePath(to).split("/");
    const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
    if (!a[0] || !b[0] || !same(a[0], b[0])) return normalizePath(to);
    let i = 0;
    while (i < a.length && i < b.length && same(a[i]!, b[i]!)) i++;
    const up: string[] = [];
    for (let k = i; k < a.length; k++) up.push("..");
    return [...up, ...b.slice(i)].join("/") || ".";
}

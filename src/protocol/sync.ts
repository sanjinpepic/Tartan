import { joinPath, normalize, type WatchSession } from "./session.ts";

/** Where downloaded files go: the local disk (CLI/server) or an HTTP upload (browser). */
export interface FileSink {
  /** True if this file was already downloaded (skip it unless forced). */
  has(path: string): Promise<boolean>;
  put(path: string, data: Uint8Array): Promise<void>;
}

export interface MirrorOptions {
  /** Re-download files that already exist locally. */
  force?: boolean;
  /** Max directory depth below the root (default 8). */
  maxDepth?: number;
  /** Skip paths matching any of these (canonical, e.g. "/zapp"). */
  exclude?: RegExp[];
  onEvent?: (e: MirrorEvent) => void;
  /** Stop between files. */
  signal?: AbortSignal;
}

export type MirrorEvent =
  | { kind: "dir"; path: string; files: number; dirs: number }
  | { kind: "skip"; path: string }
  | { kind: "progress"; path: string; bytes: number }
  | { kind: "file"; path: string; bytes: number }
  | { kind: "error"; path: string; message: string };

export interface MirrorResult {
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
}

/**
 * Copy a directory tree from the watch. Breadth-first, one request at a time.
 * Errors on single files are reported and the walk continues.
 */
export async function mirror(session: WatchSession, root: string, sink: FileSink, opts: MirrorOptions = {}): Promise<MirrorResult> {
  const emit = opts.onEvent ?? (() => {});
  const maxDepth = opts.maxDepth ?? 8;
  const excluded = (p: string) => (opts.exclude ?? []).some((re) => re.test(p));
  const result: MirrorResult = { downloaded: 0, skipped: 0, failed: 0, bytes: 0 };
  const queue: Array<{ path: string; depth: number }> = [{ path: normalize(root), depth: 0 }];

  while (queue.length && !opts.signal?.aborted) {
    const { path, depth } = queue.shift()!;
    let listing;
    try {
      listing = await session.listDir(path);
    } catch (e) {
      result.failed++;
      emit({ kind: "error", path, message: (e as Error).message });
      if (session.closed) break;
      continue;
    }
    emit({ kind: "dir", path, files: listing.files.length, dirs: listing.dirs.length });

    for (const name of listing.files) {
      if (opts.signal?.aborted) break;
      const file = joinPath(path, name);
      if (excluded(file)) continue;
      if (!opts.force && (await sink.has(file))) {
        result.skipped++;
        emit({ kind: "skip", path: file });
        continue;
      }
      try {
        const data = await session.readFile(file, (bytes) => emit({ kind: "progress", path: file, bytes }));
        await sink.put(file, data);
        result.downloaded++;
        result.bytes += data.length;
        emit({ kind: "file", path: file, bytes: data.length });
      } catch (e) {
        result.failed++;
        emit({ kind: "error", path: file, message: (e as Error).message });
        if (session.closed) return result;
      }
    }
    if (depth < maxDepth) {
      for (const d of listing.dirs) {
        const sub = joinPath(path, d);
        if (!excluded(sub)) queue.push({ path: sub, depth: depth + 1 });
      }
    }
  }
  return result;
}

/** Best-effort guess of what a downloaded file is, from its first bytes. */
export function sniff(data: Uint8Array): string {
  const head = (n: number) => String.fromCharCode(...data.subarray(0, n));
  if (data.length >= 12 && String.fromCharCode(...data.subarray(8, 12)) === ".FIT") return "FIT activity file";
  if (head(2) === "PK") return "ZIP archive";
  if (data[0] === 0x1f && data[1] === 0x8b) return "gzip";
  if (head(5) === "<?xml") return "XML (SML?)";
  const first = String.fromCharCode(...data.subarray(0, 64)).trimStart();
  if (first.startsWith("{") || first.startsWith("[")) return "JSON";
  let printable = 0;
  const sample = data.subarray(0, 512);
  for (const b of sample) if ((b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13) printable++;
  if (sample.length && printable / sample.length > 0.95) return "text";
  return "binary";
}

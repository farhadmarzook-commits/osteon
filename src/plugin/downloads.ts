/**
 * Are the vault's pictures on this device? iCloud can offload a vault's files from a phone; reading
 * one then waits on a download, and cards or notes with pictures hang. A few sample reads, each
 * given a time limit, tell the two cases apart without holding anything up.
 */
export interface DownloadCheck {
  checked: number;
  /** Reads that failed or didn't finish in time. */
  missing: number;
}

export function samplePaths(paths: readonly string[], n: number, random: () => number = Math.random): string[] {
  const pool = [...paths];
  const out: string[] = [];
  while (pool.length && out.length < n) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return out;
}

export async function probeDownloads(read: (path: string) => Promise<unknown>, paths: readonly string[], timeoutMs: number): Promise<DownloadCheck> {
  const results = await Promise.all(
    paths.map(
      (p) =>
        new Promise<boolean>((resolve) => {
          const timer = window.setTimeout(() => resolve(false), timeoutMs);
          read(p).then(
            () => {
              window.clearTimeout(timer);
              resolve(true);
            },
            () => {
              window.clearTimeout(timer);
              resolve(false);
            },
          );
        }),
    ),
  );
  return { checked: paths.length, missing: results.filter((ok) => !ok).length };
}

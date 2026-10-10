import { readFileSync, existsSync } from "fs";
import { describe, expect, it } from "vitest";
import { optimize, sequencesFrom } from "../src/core/optimizer";
const F = process.env.FC_HISTORY ?? "";
describe.skipIf(!F || !existsSync(F))("optimizer on a real exported history (local only)", () => {
  it("runs fast and improves the fit", async () => {
    const all = JSON.parse(readFileSync(F, "utf8")) as Array<{ p: string; r: Array<{ ts: string; rating: string }> }>;
    for (const pid of [...new Set(all.map((x) => x.p))]) {
      const seqs = sequencesFrom(all.filter((x) => x.p === pid).map((x) => x.r), 4);
      const t0 = performance.now();
      const res = await optimize(seqs);
      console.log(pid, `cards ${seqs.length}, reviews ${res.reviews}, loss ${res.lossBefore.toFixed(4)} -> ${res.lossAfter.toFixed(4)}, ${(performance.now() - t0).toFixed(0)} ms`);
      expect(res.lossAfter).toBeLessThanOrEqual(res.lossBefore);
    }
  }, 120000);
});

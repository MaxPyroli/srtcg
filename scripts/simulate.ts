/**
 * Simulation : combien de boosters faut-il ouvrir pour compléter la collection ?
 * Utilise le vrai code de tirage (src/draw.ts) et les probabilités de src/config.ts.
 *
 *   npm run simulate            # 4 000 joueurs
 *   npm run simulate -- 20000   # nombre de joueurs au choix
 *
 * Hypothèses : chaque joueur joue seul (aucun échange) et chaque carte d'une même
 * rareté est équiprobable. La carte secrète est comptée à part.
 */
import { drawBooster } from '../src/draw.ts';
import type { Catalog } from '../src/draw.ts';
import { seededRng } from '../src/rng.ts';

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
const catalog: Catalog = {
  commune: range(1, 50),
  peu_commune: range(51, 35),
  rare: range(86, 10),
  legendaire: range(96, 5),
  secrete: [101],
};
const rarityOf = (id: number) =>
  id <= 50 ? 'commune' : id <= 85 ? 'peu_commune' : id <= 95 ? 'rare' : id <= 100 ? 'legendaire' : 'secrete';

const players = Number(process.argv[2] ?? 4000);
const rng = seededRng(2026);
const RARITIES = ['commune', 'peu_commune', 'rare', 'legendaire'] as const;

const done: Record<string, number[]> = { commune: [], peu_commune: [], rare: [], legendaire: [], serie: [], secrete: [] };

for (let p = 0; p < players; p++) {
  const owned: Record<string, Set<number>> = { commune: new Set(), peu_commune: new Set(), rare: new Set(), legendaire: new Set() };
  const finishedAt: Record<string, number> = {};
  let secretAt = 0;
  for (let n = 1; n <= 20000; n++) {
    const b = drawBooster(catalog, rng);
    for (const id of b.cardIds) {
      const r = rarityOf(id);
      if (r === 'secrete') { if (!secretAt) secretAt = n; } else owned[r].add(id);
    }
    for (const r of RARITIES) {
      if (finishedAt[r] === undefined && owned[r].size === catalog[r].length) finishedAt[r] = n;
    }
    if (RARITIES.every((r) => finishedAt[r] !== undefined) && secretAt) break;
  }
  for (const r of RARITIES) done[r].push(finishedAt[r]);
  done.serie.push(Math.max(...RARITIES.map((r) => finishedAt[r])));
  done.secrete.push(secretAt);
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const q = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.floor(p * (v.length - 1))];

console.log(`${players} joueurs simulés\n`);
console.log('rareté'.padEnd(22), 'moyenne'.padStart(8), 'médiane'.padStart(8), '90 %'.padStart(8));
for (const [label, key] of [
  ['communes (50)', 'commune'], ['peu communes (35)', 'peu_commune'], ['rares (10)', 'rare'],
  ['légendaires (5)', 'legendaire'], ['série complète', 'serie'], ['carte secrète', 'secrete'],
] as const) {
  console.log(label.padEnd(22), mean(done[key]).toFixed(0).padStart(8), String(q(done[key], 0.5)).padStart(8), String(q(done[key], 0.9)).padStart(8));
}

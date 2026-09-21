import { describe, it, expect } from 'vitest';
import { drawBooster } from '../src/draw.ts';
import type { Catalog } from '../src/draw.ts';
import { seededRng } from '../src/rng.ts';

// Même découpage que le catalogue provisoire : 50 / 35 / 10 / 5 + 1 secrète
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

describe('drawBooster : structure', () => {
  it('donne toujours 5 cartes du catalogue', () => {
    const rng = seededRng(1);
    for (let i = 0; i < 5000; i++) {
      const b = drawBooster(catalog, rng);
      expect(b.cardIds).toHaveLength(5);
      for (const id of b.cardIds) expect(id).toBeGreaterThanOrEqual(1);
      for (const id of b.cardIds) expect(id).toBeLessThanOrEqual(101);
    }
  });

  it('les cartes 1 à 3 sont toujours des communes (hors God Pack)', () => {
    const rng = seededRng(2);
    for (let i = 0; i < 5000; i++) {
      const b = drawBooster(catalog, rng);
      if (b.kind === 'god') continue;
      for (const id of b.cardIds.slice(0, 3)) expect(rarityOf(id)).toBe('commune');
    }
  });

  it("la carte 4 n'est jamais légendaire ni secrète", () => {
    const rng = seededRng(3);
    for (let i = 0; i < 5000; i++) {
      const b = drawBooster(catalog, rng);
      if (b.kind === 'god') continue;
      expect(['commune', 'peu_commune', 'rare']).toContain(rarityOf(b.cardIds[3]));
    }
  });

  it("la carte 5 n'est jamais une commune", () => {
    const rng = seededRng(4);
    for (let i = 0; i < 5000; i++) {
      const b = drawBooster(catalog, rng);
      expect(rarityOf(b.cardIds[4])).not.toBe('commune');
    }
  });

  it('un God Pack contient 1 peu commune, 3 rares différentes et 1 légendaire', () => {
    const rng = seededRng(5);
    let seen = 0;
    for (let i = 0; i < 200000 && seen < 50; i++) {
      const b = drawBooster(catalog, rng);
      if (b.kind !== 'god') continue;
      seen++;
      expect(b.cardIds.map(rarityOf)).toEqual(['peu_commune', 'rare', 'rare', 'rare', 'legendaire']);
      expect(new Set(b.cardIds.slice(1, 4)).size).toBe(3);
    }
    expect(seen).toBe(50);
  });

  it('un booster secret contient la carte 101 en 5e position', () => {
    const rng = seededRng(6);
    let seen = 0;
    for (let i = 0; i < 100000 && seen < 50; i++) {
      const b = drawBooster(catalog, rng);
      if (b.kind !== 'secret') continue;
      seen++;
      expect(b.cardIds[4]).toBe(101);
      expect(b.cardIds.slice(0, 3).map(rarityOf)).toEqual(['commune', 'commune', 'commune']);
    }
    expect(seen).toBe(50);
  });

  it('refuse un catalogue incomplet', () => {
    expect(() => drawBooster({ ...catalog, legendaire: [] }, seededRng(1))).toThrow(/Catalogue incomplet/);
  });
});

describe('drawBooster : fréquences', () => {
  it('respecte les probabilités annoncées sur 400 000 boosters', () => {
    const rng = seededRng(2026);
    const N = 400_000;
    let god = 0, secret = 0, c4pc = 0, c4r = 0, c5r = 0, c5l = 0, normal = 0;
    for (let i = 0; i < N; i++) {
      const b = drawBooster(catalog, rng);
      if (b.kind === 'god') { god++; continue; }
      if (b.kind === 'secret') secret++;
      normal++;
      const r4 = rarityOf(b.cardIds[3]);
      if (r4 === 'peu_commune') c4pc++;
      if (r4 === 'rare') c4r++;
      if (b.kind === 'normal') {
        const r5 = rarityOf(b.cardIds[4]);
        if (r5 === 'rare') c5r++;
        if (r5 === 'legendaire') c5l++;
      }
    }
    const normalOnly = normal - secret;
    // God Pack : 1 sur 200, secrète : 1 sur 100 (parmi les boosters non God Pack)
    expect(god / N).toBeCloseTo(1 / 200, 3);
    expect(secret / normal).toBeCloseTo(1 / 100, 3);
    // Carte 4 : 1 sur 5 peu commune, 1 sur 15 rare
    expect(c4pc / normal).toBeCloseTo(1 / 5, 2);
    expect(c4r / normal).toBeCloseTo(1 / 15, 2);
    // Carte 5 (boosters normaux) : 1 sur 5 rare, 1 sur 20 légendaire
    expect(c5r / normalOnly).toBeCloseTo(1 / 5, 2);
    expect(c5l / normalOnly).toBeCloseTo(1 / 20, 2);
  });
});

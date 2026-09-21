import type { Rarity } from './types.ts';
import type { Rng } from './rng.ts';
import { ODDS, GOD_PACK } from './config.ts';

/** Identifiants des cartes, classés par rareté. */
export type Catalog = Record<Rarity, number[]>;

export type BoosterKind = 'normal' | 'secret' | 'god';

export interface Booster {
  kind: BoosterKind;
  /** Les 5 cartes, dans l'ordre de révélation. */
  cardIds: number[];
}

function pick(ids: number[], rng: Rng): number {
  return ids[rng.int(ids.length)];
}

/** Tire n cartes différentes. */
function pickDistinct(ids: number[], n: number, rng: Rng): number[] {
  const pool = ids.slice();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = rng.int(pool.length);
    out.push(pool[j]);
    pool.splice(j, 1);
  }
  return out;
}

function requireRarity(catalog: Catalog, rarity: Rarity, needed: number): void {
  if (catalog[rarity].length < needed) {
    throw new Error(`Catalogue incomplet : il faut au moins ${needed} carte(s) de rareté "${rarity}"`);
  }
}

/**
 * Tire un booster de 5 cartes.
 *
 *  1. God Pack (1 sur 200) : 1 peu commune, 3 rares différentes, 1 légendaire.
 *  2. Sinon, cartes 1 à 3 : toujours communes.
 *  3. Carte 4 : commune, avec 1 chance sur 5 d'être peu commune et 1 sur 15 d'être rare.
 *  4. Carte 5 : avec 1 chance sur 100, la carte secrète ; sinon peu commune,
 *     avec 1 chance sur 5 d'être rare et 1 sur 20 d'être légendaire.
 */
export function drawBooster(catalog: Catalog, rng: Rng, odds = ODDS): Booster {
  requireRarity(catalog, 'commune', 1);
  requireRarity(catalog, 'peu_commune', 1);
  requireRarity(catalog, 'rare', GOD_PACK.rare);
  requireRarity(catalog, 'legendaire', 1);

  if (rng.float() < odds.godPack) {
    return {
      kind: 'god',
      cardIds: [
        ...pickDistinct(catalog.peu_commune, GOD_PACK.peuCommune, rng),
        ...pickDistinct(catalog.rare, GOD_PACK.rare, rng),
        ...pickDistinct(catalog.legendaire, GOD_PACK.legendaire, rng),
      ],
    };
  }

  const cardIds: number[] = [];
  for (let i = 0; i < 3; i++) cardIds.push(pick(catalog.commune, rng));

  const x = rng.float();
  if (x < odds.card4.rare) cardIds.push(pick(catalog.rare, rng));
  else if (x < odds.card4.rare + odds.card4.peuCommune) cardIds.push(pick(catalog.peu_commune, rng));
  else cardIds.push(pick(catalog.commune, rng));

  if (rng.float() < odds.secret && catalog.secrete.length > 0) {
    cardIds.push(pick(catalog.secrete, rng));
    return { kind: 'secret', cardIds };
  }

  const y = rng.float();
  if (y < odds.card5.legendaire) cardIds.push(pick(catalog.legendaire, rng));
  else if (y < odds.card5.legendaire + odds.card5.rare) cardIds.push(pick(catalog.rare, rng));
  else cardIds.push(pick(catalog.peu_commune, rng));

  return { kind: 'normal', cardIds };
}

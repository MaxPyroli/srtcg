/** Source d'aléatoire. Injectable pour pouvoir tester avec des tirages reproductibles. */
export interface Rng {
  /** Nombre réel dans [0, 1). */
  float(): number;
  /** Entier dans [0, maxExclusive). */
  int(maxExclusive: number): number;
}

/** Aléatoire sécurisé du serveur : c'est celui-ci qui sert en production. */
export const cryptoRng: Rng = {
  float() {
    const b = new Uint32Array(2);
    crypto.getRandomValues(b);
    // 53 bits d'aléa : 27 bits + 26 bits
    return ((b[0] >>> 5) * 67108864 + (b[1] >>> 6)) / 9007199254740992;
  },
  int(maxExclusive: number) {
    return Math.floor(this.float() * maxExclusive);
  },
};

/** Générateur reproductible (mulberry32), réservé aux tests et aux simulations. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float: next,
    int(maxExclusive: number) {
      return Math.floor(next() * maxExclusive);
    },
  };
}

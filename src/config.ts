/**
 * Réglages du jeu. Tout ce qui touche à l'équilibrage est ici.
 * Les probabilités sont des propositions de départ, faites pour être ajustées.
 */
export const ODDS = {
  /** Un booster sur 2000 est un God Pack. */
  godPack: 1 / 2000,
  /** Un booster sur 1000 contient la carte secrète (à la place de la carte 5). */
  secret: 1 / 1000,
  /** Carte 4 : commune par défaut, avec une chance d'être peu commune ou rare. */
  card4: { peuCommune: 1 / 5, rare: 1 / 15 },
  /** Carte 5 : peu commune par défaut, avec une chance d'être rare ou légendaire. */
  card5: { rare: 1 / 5, legendaire: 1 / 100 },
} as const;

/** Contenu d'un God Pack. */
export const GOD_PACK = { peuCommune: 1, rare: 3, legendaire: 1 } as const;

/** Durée d'une session de jeu. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Nombre maximal de boosters qu'un admin peut offrir d'un coup. */
export const MAX_GRANT = 100;

/**
 * Réglages du jeu. Tout ce qui touche à l'équilibrage est ici.
 * Les probabilités sont des propositions de départ, faites pour être ajustées.
 */
export const ODDS = {
  /** Un booster sur 1000 est un God Pack. */
  godPack: 1 / 1000,
  /** Un booster sur 500 contient la carte secrète (à la place de la carte 5). */
  secret: 1 / 500,
  /** Carte 4 : commune par défaut, avec une chance d'être peu commune ou rare. */
  card4: { peuCommune: 1 / 5, rare: 1 / 15 },
  /** Carte 5 : peu commune par défaut, avec une chance d'être rare ou légendaire. */
  card5: { rare: 1 / 5, legendaire: 1 / 50 },
} as const;

/** Contenu d'un God Pack. */
export const GOD_PACK = { peuCommune: 1, rare: 3, legendaire: 1 } as const;

/** Durée d'une session de jeu. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Nombre maximal de boosters qu'un admin peut offrir d'un coup. */
export const MAX_GRANT = 100;

/** Une demande d'échange sans réponse expire au bout de ce délai. */
export const TRADE_EXPIRY_HOURS = 48;

/** Nombre maximal de monnaie qu'un admin peut offrir d'un coup (la monnaie ne sert à rien pour l'instant). */
export const MAX_CURRENCY_GRANT = 10_000;

/** Longueur maximale d'une raison de bannissement. */
export const MAX_BAN_REASON_LENGTH = 200;

/** Nombre maximal d'utilisations pour un code de boosters. */
export const MAX_CODE_USES = 10_000;

/** Durée de validité maximale d'un code de boosters, en heures (ici : 1 an). */
export const MAX_CODE_HOURS = 24 * 365;

/** Longueur maximale de la bio d'un profil (doit correspondre au CHECK de migrations/0004_profiles.sql). */
export const MAX_BIO_LENGTH = 200;

/**
 * Icônes de profil disponibles. Pas d'upload d'image : en attendant l'univers du jeu,
 * chacun choisit un emoji et une couleur dans une liste fixe.
 */
export const AVATAR_EMOJIS = [
  '🙂', '😎', '🤖', '🐉', '🦊', '🐺', '🐸', '🐙', '🦉', '🦁',
  '🐯', '🐼', '🦄', '🐲', '🎮', '🃏', '⚡', '🔥', '❄️', '🌊',
  '🌙', '⭐', '🍀', '🍄', '🎯', '🎲', '🏆', '👾', '🧙', '🦾',
  '🐧', '🦜', '🐨', '🐢', '🦋', '🌵', '🍉', '🍩', '☕', '💎',
] as const;

export const AVATAR_COLORS = [
  '#2b59c3', '#b3261e', '#2f9e6e', '#d69a12', '#8a45d1',
  '#3b6fd4', '#c2410c', '#0f766e', '#a21caf', '#475569',
] as const;

// ---------------------------------------------------------------------------
// Suikamon (mini-jeu de fusion de Poké Balls, classement public sans compte)
// ---------------------------------------------------------------------------

/** Plus haut score accepté, quoi qu'il arrive. */
export const SUIKAMON_MAX_SCORE = 1_000_000;

/** Un score ne peut pas dépasser ce nombre de points par seconde de partie (réel : ~5 pour un très bon joueur)... */
export const SUIKAMON_MAX_POINTS_PER_SECOND = 30;

/** ...plus cette marge, pour les grosses chaînes du début de partie. */
export const SUIKAMON_SCORE_MARGIN = 500;

/** Une partie plus courte que ça n'est pas enregistrée. */
export const SUIKAMON_MIN_RUN_SECONDS = 10;

/** Au-delà, le jeton de partie est périmé (une partie ne dure pas 6 heures). */
export const SUIKAMON_RUN_TTL_SECONDS = 6 * 3600;

/** Nombre de lignes du classement affichées. */
export const SUIKAMON_LEADERBOARD_SIZE = 20;

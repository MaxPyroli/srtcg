export type Rarity = 'commune' | 'peu_commune' | 'rare' | 'legendaire' | 'secrete';

export const RARITIES: Rarity[] = ['commune', 'peu_commune', 'rare', 'legendaire', 'secrete'];

export interface CardRow {
  id: number;
  slug: string;
  name: string;
  rarity: Rarity;
  tradable: number;
  /** Chemin d'une vraie illustration (ex. /img/cards/rare-01.png), vide tant qu'il n'y en a pas. */
  image: string | null;
}

export interface UserRow {
  id: number;
  twitch_id: string;
  display_name: string;
  is_admin: number;
  boosters: number;
  currency: number;
  is_banned: number;
  ban_reason: string | null;
}

export interface Env {
  DB: D1Database;
  /** Clé secrète qui signe les cookies de session (obligatoire). */
  SESSION_SECRET: string;
  /** "1" pour autoriser la connexion de test sans Twitch. Jamais en production. */
  DEV_AUTH?: string;
  /** Pseudos administrateurs de la connexion de test, séparés par des virgules. */
  DEV_ADMINS?: string;
}

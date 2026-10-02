/**
 * Classement de Suikamon. Pas de compte : le navigateur garde une clé aléatoire (player), le serveur
 * attribue un pseudo aléatoire et ne conserve que le meilleur score.
 *
 * Un score envoyé par le navigateur ne peut pas être vérifié (le jeu tourne chez le joueur). Les garde-fous
 * rendent la triche plus pénible, pas impossible : jeton de partie signé par le serveur (sans lui, pas de
 * score), durée minimale, plafond de points par seconde écoulée, un seul envoi par partie.
 */
import type { Rng } from './rng.ts';
import { cryptoRng } from './rng.ts';
import { signToken, verifyToken } from './auth.ts';
import { GameError, translateDbError } from './db.ts';
import {
  SUIKAMON_MAX_SCORE, SUIKAMON_MAX_POINTS_PER_SECOND, SUIKAMON_SCORE_MARGIN,
  SUIKAMON_MIN_RUN_SECONDS, SUIKAMON_RUN_TTL_SECONDS, SUIKAMON_LEADERBOARD_SIZE,
} from './config.ts';

const ADJECTIFS = [
  'Rapide', 'Rusé', 'Zen', 'Turbo', 'Joyeux', 'Malin', 'Fougueux', 'Discret', 'Costaud', 'Chanceux',
  'Curieux', 'Brillant', 'Téméraire', 'Sympa', 'Furtif', 'Épique', 'Rebondi', 'Doré', 'Glacé', 'Pétillant',
];
const NOMS = [
  'Coureur', 'Pilote', 'Dresseur', 'Explorateur', 'Pain de Mie', 'Kart', 'Dériveur', 'Chasseur',
  'Aventurier', 'Champion', 'Voyageur', 'Capteur', 'Collectionneur', 'Lanceur', 'Fusionneur', 'Rouleur',
];

export function randomPseudo(rng: Rng = cryptoRng): string {
  const adj = ADJECTIFS[rng.int(ADJECTIFS.length)];
  const nom = NOMS[rng.int(NOMS.length)];
  return `${nom} ${adj} ${100 + rng.int(900)}`;
}

const PLAYER_ID = /^[0-9a-f]{32}$/;

function hex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Jeton remis au début d'une partie : « nonce.départ.signature ». Rien n'est stocké tant qu'il n'est pas utilisé. */
export async function startRun(secret: string, now = Date.now()): Promise<string> {
  const body = `${hex(8)}.${Math.floor(now / 1000)}`;
  return `${body}.${await signToken(`suikamon:${body}`, secret)}`;
}

async function readRun(run: unknown, secret: string, now: number): Promise<{ nonce: string; elapsed: number }> {
  const bad = () => new GameError('bad_run', 400, 'Partie invalide.');
  if (typeof run !== 'string') throw bad();
  const [nonce, start, sig] = run.split('.');
  if (!nonce || !start || !sig || !/^[0-9a-f]{16}$/.test(nonce) || !/^\d+$/.test(start)) throw bad();
  if (!(await verifyToken(`suikamon:${nonce}.${start}`, sig, secret))) throw bad();
  const elapsed = now / 1000 - Number(start);
  if (elapsed > SUIKAMON_RUN_TTL_SECONDS) throw new GameError('run_expired', 410, 'Cette partie est trop ancienne.');
  return { nonce, elapsed };
}

export function maxPlausibleScore(elapsedSeconds: number): number {
  return Math.floor(elapsedSeconds * SUIKAMON_MAX_POINTS_PER_SECOND) + SUIKAMON_SCORE_MARGIN;
}

export interface MyScore { pseudo: string; score: number; rank: number }

async function rankOf(db: D1Database, playerId: string): Promise<MyScore | null> {
  const row = await db
    .prepare(
      `SELECT pseudo, score,
              (SELECT COUNT(*) FROM suikamon_scores o WHERE o.score > s.score) + 1 AS rank
         FROM suikamon_scores s WHERE player_id = ?`,
    )
    .bind(playerId)
    .first<MyScore>();
  return row;
}

export async function submitScore(
  db: D1Database,
  secret: string,
  input: { run: unknown; score: unknown; player: unknown },
  now = Date.now(),
  rng: Rng = cryptoRng,
): Promise<MyScore & { improved: boolean }> {
  const { score, player } = input;
  if (typeof player !== 'string' || !PLAYER_ID.test(player)) throw new GameError('bad_request', 400, 'Joueur invalide.');
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > SUIKAMON_MAX_SCORE) {
    throw new GameError('bad_request', 400, 'Score invalide.');
  }
  const { nonce, elapsed } = await readRun(input.run, secret, now);
  if (elapsed < SUIKAMON_MIN_RUN_SECONDS) throw new GameError('run_too_short', 422, 'Partie trop courte pour être enregistrée.');
  if (score > maxPlausibleScore(elapsed)) throw new GameError('score_implausible', 422, 'Score refusé : trop élevé pour la durée de la partie.');

  const before = await rankOf(db, player);
  try {
    // Un seul lot : si le jeton a déjà servi, l'insertion échoue et rien d'autre n'est écrit.
    await db.batch([
      db.prepare("DELETE FROM suikamon_runs WHERE used_at < datetime('now', '-1 day')"),
      db.prepare('INSERT INTO suikamon_runs (nonce) VALUES (?)').bind(nonce),
      db
        .prepare(
          `INSERT INTO suikamon_scores (player_id, pseudo, score) VALUES (?, ?, ?)
           ON CONFLICT (player_id) DO UPDATE SET
             score = MAX(score, excluded.score),
             updated_at = CASE WHEN excluded.score > score THEN datetime('now') ELSE updated_at END`,
        )
        .bind(player, randomPseudo(rng), score),
    ]);
  } catch (error) {
    throw translateDbError(error);
  }
  const me = (await rankOf(db, player))!;
  return { ...me, improved: !before || me.score > before.score };
}

export interface LeaderboardRow { rank: number; pseudo: string; score: number }

/** Le classement public. Les clés des joueurs n'en sortent jamais : ce sont leurs mots de passe. */
export async function getLeaderboard(
  db: D1Database,
  playerId?: string,
): Promise<{ top: LeaderboardRow[]; players: number; me: MyScore | null }> {
  const [list, count] = await Promise.all([
    db
      .prepare('SELECT pseudo, score FROM suikamon_scores ORDER BY score DESC, updated_at ASC LIMIT ?')
      .bind(SUIKAMON_LEADERBOARD_SIZE)
      .all<{ pseudo: string; score: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM suikamon_scores').first<{ n: number }>(),
  ]);
  // Les ex æquo partagent le même rang (1, 2, 2, 4).
  const top: LeaderboardRow[] = [];
  list.results.forEach((r, i) => {
    top.push({ rank: i > 0 && top[i - 1].score === r.score ? top[i - 1].rank : i + 1, pseudo: r.pseudo, score: r.score });
  });
  const me = playerId && PLAYER_ID.test(playerId) ? await rankOf(db, playerId) : null;
  return { top, players: count?.n ?? 0, me };
}

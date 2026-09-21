import type { CardRow, UserRow, Rarity } from './types.ts';
import { RARITIES } from './types.ts';
import type { Catalog, BoosterKind } from './draw.ts';
import { drawBooster } from './draw.ts';
import type { Rng } from './rng.ts';

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

export class GameError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Jetons levés par les garde-fous de la base (voir migrations/0001_init.sql). */
const DB_TOKENS: Record<string, { code: string; status: number; message: string }> = {
  E_NO_BOOSTER: { code: 'no_booster', status: 409, message: "Tu n'as aucun booster à ouvrir." },
  E_SELF_TRADE: { code: 'self_trade', status: 400, message: 'Tu ne peux pas échanger avec toi-même.' },
  E_CARD_UNKNOWN: { code: 'card_unknown', status: 400, message: 'Carte inconnue.' },
  E_SAME_CARD: { code: 'same_card', status: 400, message: 'Les deux cartes sont identiques.' },
  E_NOT_TRADABLE: { code: 'not_tradable', status: 400, message: "Une de ces cartes n'est pas échangeable." },
  E_RARITY_MISMATCH: { code: 'rarity_mismatch', status: 400, message: 'Les deux cartes doivent avoir la même rareté.' },
  E_NOT_OWNED: { code: 'not_owned', status: 409, message: "Il n'y a plus d'exemplaire disponible de la carte offerte." },
  E_TARGET_NOT_OWNED: { code: 'target_not_owned', status: 409, message: "Il n'y a plus d'exemplaire disponible de la carte demandée." },
  E_TRADE_NOT_FOUND: { code: 'trade_not_found', status: 404, message: 'Demande introuvable.' },
  E_TRADE_CLOSED: { code: 'trade_closed', status: 409, message: 'Cette demande est déjà conclue.' },
  E_FORBIDDEN: { code: 'forbidden', status: 403, message: "Tu n'as pas le droit de faire ça." },
};

/** Transforme une erreur de la base en GameError quand elle vient d'un garde-fou. */
export function translateDbError(error: unknown): unknown {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const text = parts.join(' | ');
  for (const [token, info] of Object.entries(DB_TOKENS)) {
    if (text.includes(token)) return new GameError(info.code, info.status, info.message);
  }
  // Filet de sécurité : la clé primaire de trade_resolutions empêche de conclure deux fois une demande.
  if (text.includes('trade_resolutions.trade_id')) {
    const info = DB_TOKENS.E_TRADE_CLOSED;
    return new GameError(info.code, info.status, info.message);
  }
  return error;
}

// ---------------------------------------------------------------------------
// Catalogue (mis en cache : il ne change pas pendant le jeu)
// ---------------------------------------------------------------------------

export interface CatalogData {
  cards: CardRow[];
  byId: Map<number, CardRow>;
  catalog: Catalog;
}

const CATALOG_TTL_MS = 5 * 60 * 1000;
const catalogCache = new WeakMap<object, { at: number; data: CatalogData }>();

export async function getCatalog(db: D1Database): Promise<CatalogData> {
  const hit = catalogCache.get(db);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.data;

  const { results } = await db.prepare('SELECT id, slug, name, rarity, tradable FROM cards ORDER BY id').all<CardRow>();
  const catalog = Object.fromEntries(RARITIES.map((r) => [r, [] as number[]])) as Catalog;
  const byId = new Map<number, CardRow>();
  for (const card of results) {
    catalog[card.rarity as Rarity].push(card.id);
    byId.set(card.id, card);
  }
  const data = { cards: results, byId, catalog };
  catalogCache.set(db, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------------------
// Joueurs
// ---------------------------------------------------------------------------

export async function getUser(db: D1Database, id: number): Promise<UserRow | null> {
  return db
    .prepare('SELECT id, twitch_id, display_name, is_admin, boosters FROM users WHERE id = ?1')
    .bind(id)
    .first<UserRow>();
}

/** Connexion de test : crée ou retrouve un joueur à partir d'un pseudo. */
export async function upsertDevUser(db: D1Database, name: string, isAdmin: boolean): Promise<UserRow> {
  const twitchId = `dev:${name.toLowerCase()}`;
  await db
    .prepare(
      `INSERT INTO users (twitch_id, display_name, is_admin) VALUES (?1, ?2, ?3)
       ON CONFLICT (twitch_id) DO UPDATE SET display_name = excluded.display_name, is_admin = excluded.is_admin`,
    )
    .bind(twitchId, name, isAdmin ? 1 : 0)
    .run();
  const user = await db
    .prepare('SELECT id, twitch_id, display_name, is_admin, boosters FROM users WHERE twitch_id = ?1')
    .bind(twitchId)
    .first<UserRow>();
  if (!user) throw new Error('Création du joueur impossible');
  return user;
}

export async function listUsers(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.display_name AS displayName,
              (SELECT COUNT(*) FROM collection c WHERE c.user_id = u.id AND c.quantity > 0) AS distinctCards
       FROM users u ORDER BY u.display_name COLLATE NOCASE LIMIT 200`,
    )
    .all<{ id: number; displayName: string; distinctCards: number }>();
  return results;
}

// ---------------------------------------------------------------------------
// Boosters et collection
// ---------------------------------------------------------------------------

export interface OpenedBooster {
  kind: BoosterKind;
  cards: CardRow[];
  boostersLeft: number;
}

/**
 * Ouvre un booster. Le tirage est fait ici, côté serveur.
 * Tout se passe dans un seul lot : retirer le booster du stock, ajouter les cartes,
 * enregistrer l'ouverture. Sans booster en stock, rien n'est ajouté.
 */
export async function openBooster(db: D1Database, userId: number, rng: Rng): Promise<OpenedBooster> {
  const { catalog, byId } = await getCatalog(db);
  const booster = drawBooster(catalog, rng);

  const statements = [
    db.prepare('UPDATE users SET boosters = boosters - 1 WHERE id = ?1').bind(userId),
    ...booster.cardIds.map((cardId) =>
      db
        .prepare(
          `INSERT INTO collection (user_id, card_id, quantity) VALUES (?1, ?2, 1)
           ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = quantity + 1`,
        )
        .bind(userId, cardId),
    ),
    db
      .prepare('INSERT INTO openings (user_id, kind, card_ids) VALUES (?1, ?2, ?3)')
      .bind(userId, booster.kind, JSON.stringify(booster.cardIds)),
  ];

  try {
    await db.batch(statements);
  } catch (error) {
    throw translateDbError(error);
  }

  const row = await db.prepare('SELECT boosters FROM users WHERE id = ?1').bind(userId).first<{ boosters: number }>();
  return {
    kind: booster.kind,
    cards: booster.cardIds.map((id) => byId.get(id) as CardRow),
    boostersLeft: row?.boosters ?? 0,
  };
}

export interface CollectionEntry {
  cardId: number;
  name: string;
  rarity: Rarity;
  tradable: number;
  quantity: number;
  reserved: number;
}

export async function listCollection(db: D1Database, userId: number): Promise<CollectionEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT c.card_id AS cardId, k.name, k.rarity, k.tradable, c.quantity, c.reserved
       FROM collection c JOIN cards k ON k.id = c.card_id
       WHERE c.user_id = ?1 AND c.quantity > 0
       ORDER BY c.card_id`,
    )
    .bind(userId)
    .all<CollectionEntry>();
  return results;
}

/** Offre des boosters (compte admin). L'action est journalisée. */
export async function grantBoosters(db: D1Database, adminId: number, userId: number, amount: number): Promise<number> {
  const target = await getUser(db, userId);
  if (!target) throw new GameError('user_not_found', 404, 'Joueur introuvable.');
  await db.batch([
    db.prepare('UPDATE users SET boosters = boosters + ?2 WHERE id = ?1').bind(userId, amount),
    db
      .prepare("INSERT INTO admin_log (admin_id, action, target_user, details) VALUES (?1, 'grant_boosters', ?2, ?3)")
      .bind(adminId, userId, JSON.stringify({ amount })),
  ]);
  return target.boosters + amount;
}

// ---------------------------------------------------------------------------
// Échanges
// ---------------------------------------------------------------------------

export interface TradeInput {
  toUserId: number;
  offeredCardId: number;
  requestedCardId: number;
}

/**
 * Crée une demande d'échange et réserve la carte offerte, en un seul lot.
 * Les règles (même rareté, cartes possédées, secrète exclue…) sont vérifiées par la base.
 */
export async function proposeTrade(db: D1Database, fromUserId: number, input: TradeInput): Promise<number> {
  const recipient = await getUser(db, input.toUserId);
  if (!recipient) throw new GameError('user_not_found', 404, 'Joueur introuvable.');

  let results;
  try {
    results = await db.batch([
      db
        .prepare('INSERT INTO trades (from_user, to_user, offered_card, requested_card) VALUES (?1, ?2, ?3, ?4) RETURNING id')
        .bind(fromUserId, input.toUserId, input.offeredCardId, input.requestedCardId),
      db
        .prepare('UPDATE collection SET reserved = reserved + 1 WHERE user_id = ?1 AND card_id = ?2')
        .bind(fromUserId, input.offeredCardId),
    ]);
  } catch (error) {
    throw translateDbError(error);
  }
  return (results[0].results[0] as { id: number }).id;
}

export interface TradeEntry {
  id: number;
  status: string;
  createdAt: string;
  fromUserId: number;
  fromName: string;
  toUserId: number;
  toName: string;
  offeredCardId: number;
  offeredName: string;
  offeredRarity: Rarity;
  requestedCardId: number;
  requestedName: string;
}

export async function listTrades(db: D1Database, userId: number): Promise<TradeEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.status, t.created_at AS createdAt,
              t.from_user AS fromUserId, fu.display_name AS fromName,
              t.to_user AS toUserId, tu.display_name AS toName,
              t.offered_card AS offeredCardId, oc.name AS offeredName, oc.rarity AS offeredRarity,
              t.requested_card AS requestedCardId, rc.name AS requestedName
       FROM trades t
       JOIN users fu ON fu.id = t.from_user
       JOIN users tu ON tu.id = t.to_user
       JOIN cards oc ON oc.id = t.offered_card
       JOIN cards rc ON rc.id = t.requested_card
       WHERE t.from_user = ?1 OR t.to_user = ?1
       ORDER BY t.id DESC LIMIT 100`,
    )
    .bind(userId)
    .all<TradeEntry>();
  return results;
}

export type TradeOutcome = 'accepted' | 'declined' | 'cancelled';

/**
 * Conclut une demande : accepter ou refuser (par le destinataire), annuler (par l'auteur).
 * Tout se passe dans un seul lot. Le déclencheur de la base vérifie l'état de la demande
 * au moment précis de l'exécution : une demande ne peut être conclue qu'une seule fois.
 */
export async function resolveTrade(db: D1Database, tradeId: number, actorId: number, outcome: TradeOutcome): Promise<void> {
  const trade = await db
    .prepare('SELECT id, from_user, to_user, offered_card, requested_card FROM trades WHERE id = ?1')
    .bind(tradeId)
    .first<{ id: number; from_user: number; to_user: number; offered_card: number; requested_card: number }>();
  if (!trade) throw new GameError('trade_not_found', 404, 'Demande introuvable.');

  const statements = [
    db.prepare('INSERT INTO trade_resolutions (trade_id, outcome, actor_id) VALUES (?1, ?2, ?3)').bind(tradeId, outcome, actorId),
    db.prepare("UPDATE trades SET status = ?2, resolved_at = datetime('now') WHERE id = ?1").bind(tradeId, outcome),
  ];

  if (outcome === 'accepted') {
    const upsert = `INSERT INTO collection (user_id, card_id, quantity) VALUES (?1, ?2, 1)
                    ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = quantity + 1`;
    statements.push(
      // Le demandeur perd la carte offerte (elle était réservée)
      db
        .prepare('UPDATE collection SET quantity = quantity - 1, reserved = reserved - 1 WHERE user_id = ?1 AND card_id = ?2')
        .bind(trade.from_user, trade.offered_card),
      // Le destinataire perd la carte demandée
      db.prepare('UPDATE collection SET quantity = quantity - 1 WHERE user_id = ?1 AND card_id = ?2').bind(trade.to_user, trade.requested_card),
      // Chacun reçoit la carte de l'autre
      db.prepare(upsert).bind(trade.to_user, trade.offered_card),
      db.prepare(upsert).bind(trade.from_user, trade.requested_card),
    );
  } else {
    // Refus ou annulation : la carte offerte est libérée
    statements.push(
      db.prepare('UPDATE collection SET reserved = reserved - 1 WHERE user_id = ?1 AND card_id = ?2').bind(trade.from_user, trade.offered_card),
    );
  }

  try {
    await db.batch(statements);
  } catch (error) {
    throw translateDbError(error);
  }
}

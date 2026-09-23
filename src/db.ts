import type { CardRow, UserRow, Rarity } from './types.ts';
import { RARITIES } from './types.ts';
import type { Catalog, BoosterKind } from './draw.ts';
import { drawBooster } from './draw.ts';
import type { Rng } from './rng.ts';
import { hashPassword, verifyPassword } from './auth.ts';

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
  E_CODE_NOT_FOUND: { code: 'code_not_found', status: 404, message: 'Code introuvable.' },
  E_CODE_EXPIRED: { code: 'code_expired', status: 410, message: 'Ce code a expiré.' },
  E_CODE_EXHAUSTED: { code: 'code_exhausted', status: 409, message: "Ce code a atteint son nombre maximal d'utilisations." },
  E_CODE_ALREADY_USED: { code: 'code_already_used', status: 409, message: 'Tu as déjà utilisé ce code.' },
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

  const { results } = await db.prepare('SELECT id, slug, name, rarity, tradable, image FROM cards ORDER BY id').all<CardRow>();
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
    .prepare('SELECT id, twitch_id, display_name, is_admin, boosters, currency, is_banned, ban_reason FROM users WHERE id = ?1')
    .bind(id)
    .first<UserRow>();
}

/** Mot de passe minimal pour la connexion de test : pas un vrai système de comptes, juste éviter le vide. */
const DEV_PASSWORD_MIN_LENGTH = 4;

/** Réglages génériques de l'application (gérés depuis l'admin, pas des secrets Cloudflare). */
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?1').bind(key).first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string | null): Promise<void> {
  if (value == null) {
    await db.prepare('DELETE FROM app_settings WHERE key = ?1').bind(key).run();
  } else {
    await db
      .prepare('INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .bind(key, value)
      .run();
  }
}

export const INVITE_CODE_KEY = 'invite_code';

/**
 * Connexion de test : chaque pseudo a son propre mot de passe, choisi à la première connexion
 * (premier arrivé, premier servi sur le pseudo, comme un pseudo Discord). Si un joueur oublie le
 * sien, un admin peut le réinitialiser (resetPassword ci-dessous).
 * - Nouveau pseudo : le code d'invitation (s'il est défini) doit correspondre, puis le mot de
 *   passe fourni devient le sien.
 * - Pseudo déjà utilisé mais sans mot de passe personnel (compte créé avant cette fonctionnalité,
 *   ou réinitialisé par un admin) : pas besoin du code d'invitation, le mot de passe fourni devient le sien.
 * - Pseudo avec mot de passe personnel : il doit correspondre.
 */
export async function devLogin(
  db: D1Database,
  input: { name: string; isAdmin: boolean; password: string | undefined; inviteCode: string | undefined },
): Promise<{ user: UserRow; isNew: boolean }> {
  const twitchId = `dev:${input.name.toLowerCase()}`;
  const existing = await db
    .prepare('SELECT id, twitch_id, display_name, is_admin, boosters, is_banned, ban_reason, password_hash, password_salt FROM users WHERE twitch_id = ?1')
    .bind(twitchId)
    .first<UserRow & { password_hash: string | null; password_salt: string | null }>();

  if (existing?.is_banned) {
    throw new GameError('banned', 403, existing.ban_reason ? `Compte banni : ${existing.ban_reason}` : 'Compte banni.');
  }

  if (!existing || !existing.password_hash || !existing.password_salt) {
    if (!existing) {
      const requiredInvite = await getSetting(db, INVITE_CODE_KEY);
      if (requiredInvite && input.inviteCode !== requiredInvite) {
        throw new GameError('invite_required', 401, "Code d'invitation incorrect.");
      }
    }
    if (!input.password || input.password.length < DEV_PASSWORD_MIN_LENGTH) {
      throw new GameError('weak_password', 400, `Choisis un mot de passe d'au moins ${DEV_PASSWORD_MIN_LENGTH} caractères.`);
    }
    const { hash, salt } = await hashPassword(input.password);
    if (!existing) {
      await db
        .prepare('INSERT INTO users (twitch_id, display_name, is_admin, password_hash, password_salt) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(twitchId, input.name, input.isAdmin ? 1 : 0, hash, salt)
        .run();
    } else {
      await db
        .prepare('UPDATE users SET display_name = ?2, is_admin = ?3, password_hash = ?4, password_salt = ?5 WHERE twitch_id = ?1')
        .bind(twitchId, input.name, input.isAdmin ? 1 : 0, hash, salt)
        .run();
    }
  } else {
    const ok = await verifyPassword(input.password ?? '', existing.password_hash, existing.password_salt);
    if (!ok) throw new GameError('bad_password', 401, 'Mot de passe incorrect.');
    await db
      .prepare('UPDATE users SET display_name = ?2, is_admin = ?3 WHERE twitch_id = ?1')
      .bind(twitchId, input.name, input.isAdmin ? 1 : 0)
      .run();
  }

  const user = await db
    .prepare('SELECT id, twitch_id, display_name, is_admin, boosters, currency, is_banned, ban_reason FROM users WHERE twitch_id = ?1')
    .bind(twitchId)
    .first<UserRow>();
  if (!user) throw new Error('Connexion impossible');
  return { user, isNew: !existing };
}

/** Admin : définit (ou retire, si null) le code d'invitation requis pour créer un compte. */
export async function setInviteCode(db: D1Database, adminId: number, code: string | null): Promise<void> {
  await db.batch([
    code == null
      ? db.prepare('DELETE FROM app_settings WHERE key = ?1').bind(INVITE_CODE_KEY)
      : db
          .prepare('INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
          .bind(INVITE_CODE_KEY, code),
    db
      .prepare("INSERT INTO admin_log (admin_id, action, details) VALUES (?1, 'set_invite_code', ?2)")
      .bind(adminId, JSON.stringify({ enabled: code != null })),
  ]);
}

/** Admin : efface le mot de passe d'un joueur. Il en choisit un nouveau à sa prochaine connexion. */
export async function resetPassword(db: D1Database, adminId: number, targetUserId: number): Promise<void> {
  const target = await getUser(db, targetUserId);
  if (!target) throw new GameError('user_not_found', 404, 'Joueur introuvable.');
  await db.batch([
    db.prepare('UPDATE users SET password_hash = NULL, password_salt = NULL WHERE id = ?1').bind(targetUserId),
    db.prepare("INSERT INTO admin_log (admin_id, action, target_user) VALUES (?1, 'reset_password', ?2)").bind(adminId, targetUserId),
  ]);
}

/**
 * Admin : supprime un compte et tout ce qui s'y rattache (collection, boosters ouverts, échanges,
 * codes qu'il a créés). Irréversible. L'action est journalisée après coup (le compte n'existe plus,
 * donc sans target_user).
 */
export async function deleteUser(db: D1Database, adminId: number, targetUserId: number): Promise<void> {
  if (adminId === targetUserId) throw new GameError('cannot_delete_self', 400, 'Tu ne peux pas supprimer ton propre compte.');
  const target = await getUser(db, targetUserId);
  if (!target) throw new GameError('user_not_found', 404, 'Joueur introuvable.');

  await db.batch([
    db.prepare('UPDATE admin_log SET target_user = NULL WHERE target_user = ?1').bind(targetUserId),
    db.prepare('DELETE FROM admin_log WHERE admin_id = ?1').bind(targetUserId),
    db.prepare('DELETE FROM booster_code_redemptions WHERE code_id IN (SELECT id FROM booster_codes WHERE created_by = ?1)').bind(targetUserId),
    db.prepare('DELETE FROM booster_codes WHERE created_by = ?1').bind(targetUserId),
    db.prepare('DELETE FROM booster_code_redemptions WHERE user_id = ?1').bind(targetUserId),
    db
      .prepare('DELETE FROM trade_resolutions WHERE actor_id = ?1 OR trade_id IN (SELECT id FROM trades WHERE from_user = ?1 OR to_user = ?1)')
      .bind(targetUserId),
    db.prepare('DELETE FROM trades WHERE from_user = ?1 OR to_user = ?1').bind(targetUserId),
    db.prepare('DELETE FROM collection WHERE user_id = ?1').bind(targetUserId),
    db.prepare('DELETE FROM openings WHERE user_id = ?1').bind(targetUserId),
    db.prepare('DELETE FROM notifications WHERE user_id = ?1').bind(targetUserId),
    db.prepare('DELETE FROM users WHERE id = ?1').bind(targetUserId),
    db
      .prepare("INSERT INTO admin_log (admin_id, action, details) VALUES (?1, 'delete_user', ?2)")
      .bind(adminId, JSON.stringify({ displayName: target.display_name })),
  ]);
}

/** Admin : bannit un joueur (l'empêche de se connecter, et invalide sa session en cours). */
export async function banUser(db: D1Database, adminId: number, targetUserId: number, reason: string | null): Promise<void> {
  if (adminId === targetUserId) throw new GameError('cannot_ban_self', 400, 'Tu ne peux pas te bannir toi-même.');
  const target = await getUser(db, targetUserId);
  if (!target) throw new GameError('user_not_found', 404, 'Joueur introuvable.');
  if (target.is_admin) throw new GameError('cannot_ban_admin', 400, 'Impossible de bannir un administrateur.');
  await db.batch([
    db.prepare('UPDATE users SET is_banned = 1, ban_reason = ?2 WHERE id = ?1').bind(targetUserId, reason),
    db
      .prepare("INSERT INTO admin_log (admin_id, action, target_user, details) VALUES (?1, 'ban_user', ?2, ?3)")
      .bind(adminId, targetUserId, JSON.stringify({ reason })),
  ]);
}

/** Admin : lève un bannissement. */
export async function unbanUser(db: D1Database, adminId: number, targetUserId: number): Promise<void> {
  const target = await getUser(db, targetUserId);
  if (!target) throw new GameError('user_not_found', 404, 'Joueur introuvable.');
  await db.batch([
    db.prepare('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?1').bind(targetUserId),
    db.prepare("INSERT INTO admin_log (admin_id, action, target_user) VALUES (?1, 'unban_user', ?2)").bind(adminId, targetUserId),
  ]);
}

/** Offre de la monnaie interne (compte admin). Sert à rien pour l'instant, mais l'action est journalisée. */
export async function grantCurrency(db: D1Database, adminId: number, userId: number, amount: number): Promise<number> {
  const target = await getUser(db, userId);
  if (!target) throw new GameError('user_not_found', 404, 'Joueur introuvable.');
  await db.batch([
    db.prepare('UPDATE users SET currency = currency + ?2 WHERE id = ?1').bind(userId, amount),
    db
      .prepare("INSERT INTO admin_log (admin_id, action, target_user, details) VALUES (?1, 'grant_currency', ?2, ?3)")
      .bind(adminId, userId, JSON.stringify({ amount })),
  ]);
  return target.currency + amount;
}

export interface PlayerStatsRow {
  id: number;
  displayName: string;
  boostersHeld: number;
  currency: number;
  distinctCards: number;
  totalCards: number;
  boostersOpened: number;
  tradesCompleted: number;
  completionPercent: number;
  isBanned: number;
}

/** Vue d'ensemble admin : les stats de chaque joueur, une ligne par compte. */
export async function listPlayerStats(db: D1Database): Promise<PlayerStatsRow[]> {
  const totalNonSecretRow = await db.prepare("SELECT COUNT(*) AS n FROM cards WHERE rarity <> 'secrete'").first<{ n: number }>();
  const totalNonSecret = totalNonSecretRow?.n ?? 0;

  const { results } = await db
    .prepare(
      `SELECT u.id, u.display_name AS displayName, u.boosters AS boostersHeld, u.currency, u.is_banned AS isBanned,
              (SELECT COUNT(*) FROM collection c WHERE c.user_id = u.id AND c.quantity > 0) AS distinctCards,
              (SELECT COALESCE(SUM(quantity), 0) FROM collection c WHERE c.user_id = u.id) AS totalCards,
              (SELECT COUNT(*) FROM openings o WHERE o.user_id = u.id) AS boostersOpened,
              (SELECT COUNT(*) FROM trades t WHERE (t.from_user = u.id OR t.to_user = u.id) AND t.status = 'accepted') AS tradesCompleted,
              (SELECT COUNT(*) FROM collection c JOIN cards k ON k.id = c.card_id
               WHERE c.user_id = u.id AND c.quantity > 0 AND k.rarity <> 'secrete') AS distinctNonSecret
       FROM users u ORDER BY u.display_name COLLATE NOCASE LIMIT 200`,
    )
    .all<Omit<PlayerStatsRow, 'completionPercent'> & { distinctNonSecret: number }>();

  return results.map(({ distinctNonSecret, ...rest }) => ({
    ...rest,
    completionPercent: totalNonSecret > 0 ? Math.round((distinctNonSecret / totalNonSecret) * 100) : 0,
  }));
}

export async function listUsers(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.display_name AS displayName, u.avatar_emoji AS avatarEmoji, u.avatar_color AS avatarColor,
              u.is_banned AS isBanned, u.ban_reason AS banReason,
              (SELECT COUNT(*) FROM collection c WHERE c.user_id = u.id AND c.quantity > 0) AS distinctCards
       FROM users u ORDER BY u.display_name COLLATE NOCASE LIMIT 200`,
    )
    .all<{
      id: number; displayName: string; avatarEmoji: string; avatarColor: string;
      isBanned: number; banReason: string | null; distinctCards: number;
    }>();
  return results;
}

// ---------------------------------------------------------------------------
// Profils
// ---------------------------------------------------------------------------

export interface ProfileRow {
  id: number;
  displayName: string;
  isAdmin: number;
  avatarEmoji: string;
  avatarColor: string;
  bio: string;
  createdAt: string;
  distinctCards: number;
  totalCards: number;
  boostersOpened: number;
  boostersHeld: number;
  tradesCompleted: number;
  /** % de la série possédée au moins une fois (carte secrète exclue, comme dans l'écran collection). */
  completionPercent: number;
  featuredCard: { id: number; name: string; rarity: Rarity } | null;
}

export async function getProfile(db: D1Database, userId: number): Promise<ProfileRow | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.display_name AS displayName, u.is_admin AS isAdmin,
              u.avatar_emoji AS avatarEmoji, u.avatar_color AS avatarColor, u.bio, u.created_at AS createdAt,
              u.boosters AS boostersHeld,
              (SELECT COUNT(*) FROM collection c WHERE c.user_id = u.id AND c.quantity > 0) AS distinctCards,
              (SELECT COALESCE(SUM(quantity), 0) FROM collection c WHERE c.user_id = u.id) AS totalCards,
              (SELECT COUNT(*) FROM openings o WHERE o.user_id = u.id) AS boostersOpened,
              (SELECT COUNT(*) FROM trades t WHERE (t.from_user = u.id OR t.to_user = u.id) AND t.status = 'accepted') AS tradesCompleted,
              (SELECT COUNT(*) FROM collection c JOIN cards k ON k.id = c.card_id
               WHERE c.user_id = u.id AND c.quantity > 0 AND k.rarity <> 'secrete') AS distinctNonSecret,
              (SELECT COUNT(*) FROM cards WHERE rarity <> 'secrete') AS totalNonSecret,
              fc.id AS featuredCardId, fc.name AS featuredCardName, fc.rarity AS featuredCardRarity
       FROM users u
       LEFT JOIN collection fcol ON fcol.user_id = u.id AND fcol.card_id = u.featured_card_id AND fcol.quantity >= 1
       LEFT JOIN cards fc ON fc.id = fcol.card_id
       WHERE u.id = ?1`,
    )
    .bind(userId)
    .first<
      Omit<ProfileRow, 'featuredCard' | 'completionPercent'> & {
        distinctNonSecret: number;
        totalNonSecret: number;
        featuredCardId: number | null;
        featuredCardName: string | null;
        featuredCardRarity: Rarity | null;
      }
    >();
  if (!row) return null;
  const { featuredCardId, featuredCardName, featuredCardRarity, distinctNonSecret, totalNonSecret, ...rest } = row;
  return {
    ...rest,
    completionPercent: totalNonSecret > 0 ? Math.round((distinctNonSecret / totalNonSecret) * 100) : 0,
    featuredCard: featuredCardId != null ? { id: featuredCardId, name: featuredCardName as string, rarity: featuredCardRarity as Rarity } : null,
  };
}

export interface ProfileInput {
  avatarEmoji: string;
  avatarColor: string;
  bio: string;
  featuredCardId: number | null;
}

/** Met à jour son propre profil. La carte vedette doit être une carte réellement possédée. */
export async function updateProfile(db: D1Database, userId: number, input: ProfileInput): Promise<void> {
  if (input.featuredCardId != null) {
    const owned = await db
      .prepare('SELECT 1 FROM collection WHERE user_id = ?1 AND card_id = ?2 AND quantity >= 1')
      .bind(userId, input.featuredCardId)
      .first();
    if (!owned) throw new GameError('featured_not_owned', 409, 'Tu ne possèdes pas cette carte.');
  }
  await db
    .prepare('UPDATE users SET avatar_emoji = ?2, avatar_color = ?3, bio = ?4, featured_card_id = ?5 WHERE id = ?1')
    .bind(userId, input.avatarEmoji, input.avatarColor, input.bio, input.featuredCardId)
    .run();
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
  image: string | null;
  quantity: number;
  reserved: number;
}

export async function listCollection(db: D1Database, userId: number): Promise<CollectionEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT c.card_id AS cardId, k.name, k.rarity, k.tradable, k.image, c.quantity, c.reserved
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
  const boosterWord = `booster${amount > 1 ? 's' : ''}`;
  await db.batch([
    db.prepare('UPDATE users SET boosters = boosters + ?2 WHERE id = ?1').bind(userId, amount),
    db
      .prepare("INSERT INTO admin_log (admin_id, action, target_user, details) VALUES (?1, 'grant_boosters', ?2, ?3)")
      .bind(adminId, userId, JSON.stringify({ amount })),
    db
      .prepare('INSERT INTO notifications (user_id, message, detail) VALUES (?1, ?2, ?3)')
      .bind(userId, `Tu as reçu ${amount} ${boosterWord} !`, 'Direction l\'onglet Boosters pour les ouvrir.'),
  ]);
  return target.boosters + amount;
}

/** Offre des boosters à tous les joueurs d'un coup (compte admin). L'action est journalisée une fois. */
export async function grantBoostersToAll(db: D1Database, adminId: number, amount: number): Promise<number> {
  const { results } = await db.prepare('SELECT id FROM users').all<{ id: number }>();
  const boosterWord = `booster${amount > 1 ? 's' : ''}`;
  await db.batch([
    db.prepare('UPDATE users SET boosters = boosters + ?1').bind(amount),
    db
      .prepare("INSERT INTO admin_log (admin_id, action, details) VALUES (?1, 'grant_boosters_all', ?2)")
      .bind(adminId, JSON.stringify({ amount, players: results.length })),
    ...results.map((u) =>
      db
        .prepare('INSERT INTO notifications (user_id, message, detail) VALUES (?1, ?2, ?3)')
        .bind(u.id, `Tu as reçu ${amount} ${boosterWord} !`, 'Direction l\'onglet Boosters pour les ouvrir.'),
    ),
  ]);
  return results.length;
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

// ---------------------------------------------------------------------------
// Codes de boosters
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans caractères ambigus (I, O, 0, 1)
const CODE_LENGTH = 8;

function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export interface BoosterCodeRow {
  id: number;
  code: string;
  boosters: number;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdByName: string;
  createdAt: string;
}

/** Crée un code de boosters (compte admin). L'action est journalisée. */
export async function createBoosterCode(
  db: D1Database,
  adminId: number,
  input: { boosters: number; maxUses: number; expiresInHours: number | null },
): Promise<BoosterCodeRow> {
  const code = generateCode();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO booster_codes (code, boosters, max_uses, expires_at, created_by)
         VALUES (?1, ?2, ?3, CASE WHEN ?4 IS NULL THEN NULL ELSE datetime('now', '+' || ?4 || ' hours') END, ?5)
         RETURNING id, code, boosters, max_uses AS maxUses, uses, expires_at AS expiresAt, created_at AS createdAt`,
      )
      .bind(code, input.boosters, input.maxUses, input.expiresInHours, adminId),
    db
      .prepare("INSERT INTO admin_log (admin_id, action, details) VALUES (?1, 'create_code', ?2)")
      .bind(adminId, JSON.stringify({ code, boosters: input.boosters, maxUses: input.maxUses, expiresInHours: input.expiresInHours })),
  ]);
  const row = results[0].results[0] as Omit<BoosterCodeRow, 'createdByName'>;
  return { ...row, createdByName: '' };
}

export async function listBoosterCodes(db: D1Database): Promise<BoosterCodeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.code, c.boosters, c.max_uses AS maxUses, c.uses,
              c.expires_at AS expiresAt, u.display_name AS createdByName, c.created_at AS createdAt
       FROM booster_codes c JOIN users u ON u.id = c.created_by
       ORDER BY c.id DESC LIMIT 100`,
    )
    .all<BoosterCodeRow>();
  return results;
}

/** Réclame un code : crédite les boosters. Chaque joueur ne peut réclamer un code qu'une fois. */
export async function redeemBoosterCode(db: D1Database, userId: number, codeText: string): Promise<{ boosters: number; boostersLeft: number }> {
  const normalized = codeText.trim().toUpperCase();
  const codeRow = await db.prepare('SELECT id, boosters FROM booster_codes WHERE code = ?1').bind(normalized).first<{ id: number; boosters: number }>();
  if (!codeRow) throw new GameError('code_not_found', 404, 'Code introuvable.');

  try {
    await db.batch([
      db.prepare('INSERT INTO booster_code_redemptions (code_id, user_id) VALUES (?1, ?2)').bind(codeRow.id, userId),
      db.prepare('UPDATE booster_codes SET uses = uses + 1 WHERE id = ?1').bind(codeRow.id),
      db.prepare('UPDATE users SET boosters = boosters + ?2 WHERE id = ?1').bind(userId, codeRow.boosters),
    ]);
  } catch (error) {
    throw translateDbError(error);
  }

  const row = await db.prepare('SELECT boosters FROM users WHERE id = ?1').bind(userId).first<{ boosters: number }>();
  return { boosters: codeRow.boosters, boostersLeft: row?.boosters ?? 0 };
}

// ---------------------------------------------------------------------------
// Vue d'ensemble admin
// ---------------------------------------------------------------------------

export interface AdminStats {
  totalUsers: number;
  totalBoostersHeld: number;
  totalOpenings: number;
  tradesPending: number;
  tradesResolved: number;
  activeCodes: number;
}

export async function getAdminStats(db: D1Database): Promise<AdminStats> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS totalUsers,
         (SELECT COALESCE(SUM(boosters), 0) FROM users) AS totalBoostersHeld,
         (SELECT COUNT(*) FROM openings) AS totalOpenings,
         (SELECT COUNT(*) FROM trades WHERE status = 'pending') AS tradesPending,
         (SELECT COUNT(*) FROM trades WHERE status <> 'pending') AS tradesResolved,
         (SELECT COUNT(*) FROM booster_codes WHERE uses < max_uses AND (expires_at IS NULL OR expires_at > datetime('now'))) AS activeCodes`,
    )
    .first<AdminStats>();
  return row as AdminStats;
}

export interface AdminLogEntry {
  id: number;
  createdAt: string;
  adminName: string;
  action: string;
  targetName: string | null;
  details: string | null;
}

export async function listAdminLog(db: D1Database, limit = 50): Promise<AdminLogEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id, l.created_at AS createdAt, a.display_name AS adminName, l.action,
              t.display_name AS targetName, l.details
       FROM admin_log l
       JOIN users a ON a.id = l.admin_id
       LEFT JOIN users t ON t.id = l.target_user
       ORDER BY l.id DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<AdminLogEntry>();
  return results;
}

/** Comme listTrades, mais tous joueurs confondus (vue admin). */
export async function listAllTrades(db: D1Database, limit = 30): Promise<TradeEntry[]> {
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
       ORDER BY t.id DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<TradeEntry>();
  return results;
}

export interface NotableOpening {
  id: number;
  createdAt: string;
  userName: string;
  kind: BoosterKind;
  cards: { name: string; rarity: Rarity }[];
}

/** Ouvertures récentes contenant au moins une carte rare et plus (utile pour suivre les beaux tirages). */
export async function listNotableOpenings(db: D1Database, limit = 30): Promise<NotableOpening[]> {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.opened_at AS createdAt, o.kind, o.card_ids AS cardIds, u.display_name AS userName
       FROM openings o JOIN users u ON u.id = o.user_id
       ORDER BY o.id DESC LIMIT 300`,
    )
    .all<{ id: number; createdAt: string; kind: BoosterKind; cardIds: string; userName: string }>();

  const { byId } = await getCatalog(db);
  const notable: NotableOpening[] = [];
  for (const row of results) {
    const cardIds: number[] = JSON.parse(row.cardIds);
    const rareCards = cardIds
      .map((id) => byId.get(id))
      .filter((c): c is CardRow => !!c && (c.rarity === 'rare' || c.rarity === 'legendaire' || c.rarity === 'secrete'));
    if (rareCards.length === 0) continue;
    notable.push({
      id: row.id,
      createdAt: row.createdAt,
      userName: row.userName,
      kind: row.kind,
      cards: rareCards.map((c) => ({ name: c.name, rarity: c.rarity })),
    });
    if (notable.length >= limit) break;
  }
  return notable;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationRow {
  id: number;
  message: string;
  detail: string | null;
  createdAt: string;
}

/**
 * Notifications non lues d'un joueur (ex. boosters offerts pendant qu'il n'était pas connecté),
 * marquées lues dans la foulée : elles ne s'affichent qu'une fois.
 */
export async function takeUnreadNotifications(db: D1Database, userId: number): Promise<NotificationRow[]> {
  const { results } = await db
    .prepare('SELECT id, message, detail, created_at AS createdAt FROM notifications WHERE user_id = ?1 AND read_at IS NULL ORDER BY id')
    .bind(userId)
    .all<NotificationRow>();
  if (results.length > 0) {
    await db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ?1 AND read_at IS NULL").bind(userId).run();
  }
  return results;
}

export interface OpeningHistoryEntry {
  id: number;
  createdAt: string;
  kind: BoosterKind;
  cards: { id: number; name: string; rarity: Rarity; image: string | null }[];
}

/** Historique complet des ouvertures d'un joueur (pas seulement les tirages notables). */
export async function listMyOpenings(db: D1Database, userId: number, limit = 50): Promise<OpeningHistoryEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT id, opened_at AS createdAt, kind, card_ids AS cardIds
       FROM openings WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<{ id: number; createdAt: string; kind: BoosterKind; cardIds: string }>();

  const { byId } = await getCatalog(db);
  return results.map((row) => {
    const cardIds: number[] = JSON.parse(row.cardIds);
    const cards = cardIds
      .map((id) => byId.get(id))
      .filter((c): c is CardRow => !!c)
      .map((c) => ({ id: c.id, name: c.name, rarity: c.rarity, image: c.image }));
    return { id: row.id, createdAt: row.createdAt, kind: row.kind, cards };
  });
}

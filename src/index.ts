import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, UserRow } from './types.ts';
import { SESSION_TTL_SECONDS, MAX_GRANT, MAX_CODE_USES, MAX_CODE_HOURS, MAX_BIO_LENGTH, AVATAR_EMOJIS, AVATAR_COLORS } from './config.ts';
import { cryptoRng } from './rng.ts';
import { signSession, verifySession } from './auth.ts';
import {
  GameError,
  getCatalog,
  getUser,
  devLogin,
  listUsers,
  openBooster,
  listCollection,
  grantBoosters,
  proposeTrade,
  listTrades,
  resolveTrade,
  createBoosterCode,
  listBoosterCodes,
  redeemBoosterCode,
  getAdminStats,
  listAdminLog,
  listAllTrades,
  listNotableOpenings,
  getProfile,
  updateProfile,
} from './db.ts';
import type { TradeOutcome } from './db.ts';

type AppEnv = { Bindings: Env; Variables: { user: UserRow } };

const SESSION_COOKIE = 'session';

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Gestion d'erreurs et protections communes
// ---------------------------------------------------------------------------

app.onError((error, c) => {
  if (error instanceof GameError) {
    return c.json({ error: error.code, message: error.message }, error.status as 400);
  }
  console.error(error);
  return c.json({ error: 'internal', message: 'Erreur interne.' }, 500);
});

// Défense en plus du cookie SameSite : une requête qui modifie quelque chose doit venir du même site.
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host) {
      return c.json({ error: 'forbidden_origin', message: 'Origine non autorisée.' }, 403);
    }
  }
  await next();
});

async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // corps absent ou illisible : traité comme une erreur ci-dessous
  }
  throw new GameError('bad_json', 400, 'Corps de requête JSON invalide.');
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new GameError('bad_request', 400, `Champ invalide : ${field}.`);
  }
  return value;
}

function idParam(value: string, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new GameError('bad_request', 400, `Identifiant invalide : ${field}.`);
  return n;
}

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

function sessionSecret(env: Env): string {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET est manquant');
  return env.SESSION_SECRET;
}

async function startSession(c: Context<AppEnv>, user: UserRow): Promise<void> {
  const token = await signSession(user.id, sessionSecret(c.env), SESSION_TTL_SECONDS);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

const requireUser = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  const userId = await verifySession(getCookie(c, SESSION_COOKIE), sessionSecret(c.env));
  const user = userId ? await getUser(c.env.DB, userId) : null;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Connexion requise.' }, 401);
  c.set('user', user);
  await next();
};

const requireAdmin = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  if (!c.get('user').is_admin) return c.json({ error: 'forbidden', message: 'Réservé aux administrateurs.' }, 403);
  await next();
};

/**
 * Connexion de test, sans Twitch. Désactivée par défaut : elle n'existe que si DEV_AUTH vaut "1".
 * Chaque pseudo a son propre mot de passe (choisi à la première connexion) : DEV_PASSWORD, s'il
 * est configuré, ne protège que la création d'un nouveau compte (et la récupération d'un compte
 * créé avant cette fonctionnalité), pas les connexions suivantes.
 * À remplacer par la connexion Twitch avant d'ouvrir le jeu à la communauté.
 */
app.post('/api/dev/login', async (c) => {
  if (c.env.DEV_AUTH !== '1') return c.json({ error: 'not_found', message: 'Introuvable.' }, 404);
  const body = await readJson(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!/^[\p{L}\p{N}_ -]{2,24}$/u.test(name)) {
    throw new GameError('bad_name', 400, 'Le pseudo doit faire 2 à 24 caractères (lettres, chiffres, espace, - ou _).');
  }
  const admins = (c.env.DEV_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const user = await devLogin(c.env.DB, {
    name,
    isAdmin: admins.includes(name.toLowerCase()),
    password: typeof body.password === 'string' ? body.password : undefined,
    sitePassword: typeof body.sitePassword === 'string' ? body.sitePassword : undefined,
    requiredSitePassword: c.env.DEV_PASSWORD,
  });
  await startSession(c, user);
  return c.json(publicUser(user));
});

app.post('/api/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

function publicUser(user: UserRow) {
  return { id: user.id, displayName: user.display_name, isAdmin: user.is_admin === 1, boosters: user.boosters };
}

// ---------------------------------------------------------------------------
// Routes publiques
// ---------------------------------------------------------------------------

app.get('/api/health', (c) => c.json({ ok: true }));

// ---------------------------------------------------------------------------
// Routes réservées aux joueurs connectés
// ---------------------------------------------------------------------------

app.use('/api/me', requireUser);
app.use('/api/cards', requireUser);
app.use('/api/users', requireUser);
app.use('/api/users/*', requireUser);
app.use('/api/collection', requireUser);
app.use('/api/boosters/*', requireUser);
app.use('/api/trades', requireUser);
app.use('/api/trades/*', requireUser);
app.use('/api/codes/*', requireUser);
app.use('/api/profile', requireUser);
app.use('/api/profile/*', requireUser);
app.use('/api/admin/*', requireUser, requireAdmin);

app.get('/api/me', (c) => c.json(publicUser(c.get('user'))));

app.get('/api/cards', async (c) => {
  const { cards } = await getCatalog(c.env.DB);
  return c.json(cards.map((k) => ({ id: k.id, name: k.name, rarity: k.rarity, tradable: k.tradable === 1 })));
});

// Les collections sont visibles par tous les joueurs connectés.
app.get('/api/users', async (c) => c.json(await listUsers(c.env.DB)));

app.get('/api/users/:id/collection', async (c) => {
  const id = idParam(c.req.param('id'), 'id');
  const profile = await getProfile(c.env.DB, id);
  if (!profile) throw new GameError('user_not_found', 404, 'Joueur introuvable.');
  return c.json({ user: profile, cards: await listCollection(c.env.DB, id) });
});

// --- Profil -----------------------------------------------------------------

app.get('/api/profile/options', (c) => c.json({ emojis: AVATAR_EMOJIS, colors: AVATAR_COLORS, maxBioLength: MAX_BIO_LENGTH }));

app.post('/api/profile', async (c) => {
  const body = await readJson(c);
  const avatarEmoji = typeof body.avatarEmoji === 'string' ? body.avatarEmoji : '';
  if (!(AVATAR_EMOJIS as readonly string[]).includes(avatarEmoji)) throw new GameError('bad_request', 400, 'Icône invalide.');
  const avatarColor = typeof body.avatarColor === 'string' ? body.avatarColor : '';
  if (!(AVATAR_COLORS as readonly string[]).includes(avatarColor)) throw new GameError('bad_request', 400, 'Couleur invalide.');
  const bio = typeof body.bio === 'string' ? body.bio.trim() : '';
  if (bio.length > MAX_BIO_LENGTH) throw new GameError('bad_request', 400, `La bio est limitée à ${MAX_BIO_LENGTH} caractères.`);
  const featuredCardId = body.featuredCardId == null ? null : positiveInt(body.featuredCardId, 'featuredCardId');
  await updateProfile(c.env.DB, c.get('user').id, { avatarEmoji, avatarColor, bio, featuredCardId });
  return c.json(await getProfile(c.env.DB, c.get('user').id));
});

app.get('/api/collection', async (c) => c.json(await listCollection(c.env.DB, c.get('user').id)));

app.post('/api/boosters/open', async (c) => {
  const opened = await openBooster(c.env.DB, c.get('user').id, cryptoRng);
  return c.json({
    kind: opened.kind,
    boostersLeft: opened.boostersLeft,
    cards: opened.cards.map((k) => ({ id: k.id, name: k.name, rarity: k.rarity })),
  });
});

// --- Échanges -------------------------------------------------------------

app.get('/api/trades', async (c) => c.json(await listTrades(c.env.DB, c.get('user').id)));

app.post('/api/trades', async (c) => {
  const body = await readJson(c);
  const id = await proposeTrade(c.env.DB, c.get('user').id, {
    toUserId: positiveInt(body.toUserId, 'toUserId'),
    offeredCardId: positiveInt(body.offeredCardId, 'offeredCardId'),
    requestedCardId: positiveInt(body.requestedCardId, 'requestedCardId'),
  });
  return c.json({ id }, 201);
});

const OUTCOMES: Record<string, TradeOutcome> = { accept: 'accepted', decline: 'declined', cancel: 'cancelled' };

app.post('/api/trades/:id/:action', async (c) => {
  const outcome = OUTCOMES[c.req.param('action')];
  if (!outcome) throw new GameError('not_found', 404, 'Action inconnue.');
  await resolveTrade(c.env.DB, idParam(c.req.param('id'), 'id'), c.get('user').id, outcome);
  return c.json({ ok: true, status: outcome });
});

// --- Codes de boosters ------------------------------------------------------

app.post('/api/codes/redeem', async (c) => {
  const body = await readJson(c);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code) throw new GameError('bad_request', 400, 'Code manquant.');
  const result = await redeemBoosterCode(c.env.DB, c.get('user').id, code);
  return c.json(result);
});

// --- Administration -------------------------------------------------------

app.post('/api/admin/grant', async (c) => {
  const body = await readJson(c);
  const amount = positiveInt(body.amount, 'amount');
  if (amount > MAX_GRANT) throw new GameError('bad_request', 400, `Maximum ${MAX_GRANT} boosters à la fois.`);
  const boosters = await grantBoosters(c.env.DB, c.get('user').id, positiveInt(body.userId, 'userId'), amount);
  return c.json({ userId: body.userId, boosters });
});

app.post('/api/admin/codes', async (c) => {
  const body = await readJson(c);
  const boosters = positiveInt(body.boosters, 'boosters');
  if (boosters > MAX_GRANT) throw new GameError('bad_request', 400, `Maximum ${MAX_GRANT} boosters par utilisation.`);
  const maxUses = positiveInt(body.maxUses, 'maxUses');
  if (maxUses > MAX_CODE_USES) throw new GameError('bad_request', 400, `Maximum ${MAX_CODE_USES} utilisations.`);
  let expiresInHours: number | null = null;
  if (body.expiresInHours != null) {
    expiresInHours = positiveInt(body.expiresInHours, 'expiresInHours');
    if (expiresInHours > MAX_CODE_HOURS) throw new GameError('bad_request', 400, `Maximum ${MAX_CODE_HOURS} heures.`);
  }
  const created = await createBoosterCode(c.env.DB, c.get('user').id, { boosters, maxUses, expiresInHours });
  return c.json(created, 201);
});

app.get('/api/admin/codes', async (c) => c.json(await listBoosterCodes(c.env.DB)));

app.get('/api/admin/overview', async (c) => {
  const [stats, adminLog, trades, notableOpenings] = await Promise.all([
    getAdminStats(c.env.DB),
    listAdminLog(c.env.DB),
    listAllTrades(c.env.DB),
    listNotableOpenings(c.env.DB),
  ]);
  return c.json({ stats, adminLog, trades, notableOpenings });
});

// Les pages du site (dossier public/) sont servies par Cloudflare avant d'arriver ici.
app.notFound((c) => c.json({ error: 'not_found', message: 'Introuvable.' }, 404));

export default app;

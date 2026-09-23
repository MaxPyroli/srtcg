import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index.ts';
import { FakeD1 } from './fakeD1.ts';

// Numéros du catalogue provisoire : communes 1-50, peu communes 51-85, rares 86-95,
// légendaires 96-100, secrète 101 (non échangeable).
const COMMUNE_A = 1;
const COMMUNE_B = 2;
const PEU_COMMUNE = 51;
const RARE = 86;
const SECRETE = 101;

let db: FakeD1;
let env: Record<string, unknown>;

beforeEach(() => {
  db = new FakeD1();
  env = { DB: db, SESSION_SECRET: 'secret-de-test', DEV_AUTH: '1', DEV_ADMINS: 'chef' };
});

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) {
  const res = await app.request(
    path,
    {
      method,
      headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    },
    env,
  );
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* pas du JSON */ }
  return { status: res.status, json, headers: res.headers };
}

async function login(name: string, password = 'password123') {
  const res = await call('POST', '/api/dev/login', { body: { name, password } });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return { cookie, id: res.json.id as number };
}

function give(userId: number, cardId: number, quantity = 1) {
  db.exec(
    `INSERT INTO collection (user_id, card_id, quantity) VALUES (${userId}, ${cardId}, ${quantity})
     ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = quantity + ${quantity}`,
  );
}

function qty(userId: number, cardId: number) {
  const row = db.one('SELECT quantity, reserved FROM collection WHERE user_id = ? AND card_id = ?', userId, cardId);
  return { quantity: Number(row?.quantity ?? 0), reserved: Number(row?.reserved ?? 0) };
}

describe('connexion', () => {
  it('refuse les routes de jeu sans session', async () => {
    expect((await call('GET', '/api/me')).status).toBe(401);
    expect((await call('POST', '/api/boosters/open')).status).toBe(401);
  });

  it('la connexion de test est absente quand DEV_AUTH est coupé', async () => {
    env.DEV_AUTH = '0';
    const res = await call('POST', '/api/dev/login', { body: { name: 'alice' } });
    expect(res.status).toBe(404);
  });

  it('un nouveau pseudo choisit librement son mot de passe, sans rien d\'autre à fournir', async () => {
    const res = await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'toto1234' } });
    expect(res.status).toBe(200);
    expect((await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'toto1234' } })).status).toBe(200);
  });

  it('refuse un mot de passe trop court à la création du compte', async () => {
    const res = await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'abc' } });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('weak_password');
  });

  it('chaque joueur a son propre mot de passe : celui d\'un autre ne fonctionne pas', async () => {
    await login('alice', 'motdepassealice');
    await login('bob', 'motdepassebob');
    const res = await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'motdepassebob' } });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe('bad_password');
    expect((await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'motdepassealice' } })).status).toBe(200);
  });

  it('un compte créé avant cette fonctionnalité (sans mot de passe personnel) se réclame comme un nouveau pseudo', async () => {
    db.exec("INSERT INTO users (twitch_id, display_name) VALUES ('dev:ancien', 'ancien')");
    const claimed = await call('POST', '/api/dev/login', { body: { name: 'ancien', password: 'monproprepass' } });
    expect(claimed.status).toBe(200);
    // Une fois réclamé, le mot de passe personnel fait foi.
    expect((await call('POST', '/api/dev/login', { body: { name: 'ancien', password: 'autrechose' } })).status).toBe(401);
    const second = await call('POST', '/api/dev/login', { body: { name: 'ancien', password: 'monproprepass' } });
    expect(second.status).toBe(200);
    expect(second.json.id).toBe(claimed.json.id);
  });

  it('un admin réinitialise le mot de passe d\'un joueur, qui peut alors s\'en choisir un nouveau', async () => {
    const chef = await login('chef');
    const alice = await login('alice', 'ancienmdp');
    expect((await call('POST', `/api/admin/users/${alice.id}/reset-password`, { cookie: chef.cookie })).status).toBe(200);
    // Le mot de passe a bien été effacé : un mot de passe différent de l'ancien est accepté et devient le nouveau.
    const res = await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'nouveaumdp' } });
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(alice.id);
    // Il fait foi désormais : l'ancien ne fonctionne plus.
    expect((await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'ancienmdp' } })).status).toBe(401);
  });

  it('réserve la réinitialisation de mot de passe aux admins', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    expect((await call('POST', `/api/admin/users/${bob.id}/reset-password`, { cookie: alice.cookie })).status).toBe(403);
  });

  it('connecte un joueur et retrouve son profil', async () => {
    const alice = await login('alice');
    const me = await call('GET', '/api/me', { cookie: alice.cookie });
    expect(me.json).toMatchObject({ displayName: 'alice', isAdmin: false, boosters: 0 });
  });

  it('rejette un cookie falsifié', async () => {
    const alice = await login('alice');
    const res = await call('GET', '/api/me', { cookie: alice.cookie.slice(0, -3) + 'xyz' });
    expect(res.status).toBe(401);
  });

  it('refuse une requête venant d\'un autre site', async () => {
    const alice = await login('alice');
    const res = await app.request(
      '/api/boosters/open',
      { method: 'POST', headers: { cookie: alice.cookie, origin: 'https://autre-site.example' } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it('normalise les espaces du pseudo (évite les quasi-doublons)', async () => {
    const created = await call('POST', '/api/dev/login', { body: { name: '  Max   Pyroli  ', password: 'motdepasse1' } });
    expect(created.status).toBe(200);
    expect(created.json.displayName).toBe('Max Pyroli');
    const again = await call('POST', '/api/dev/login', { body: { name: 'Max   Pyroli', password: 'motdepasse1' } });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(created.json.id);
  });
});

describe('code d\'invitation', () => {
  it('aucun code requis par défaut', async () => {
    const res = await call('GET', '/api/invite-required');
    expect(res.json).toEqual({ required: false });
    expect((await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'motdepasse1' } })).status).toBe(200);
  });

  it('un admin définit un code : il devient requis pour créer un compte', async () => {
    const chef = await login('chef');
    expect((await call('POST', '/api/admin/invite-code', { cookie: chef.cookie, body: { code: 'BIENVENUE' } })).status).toBe(200);

    expect((await call('GET', '/api/invite-required')).json).toEqual({ required: true });

    const refused = await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'motdepasse1' } });
    expect(refused.status).toBe(401);
    expect(refused.json.error).toBe('invite_required');

    const accepted = await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'motdepasse1', inviteCode: 'BIENVENUE' } });
    expect(accepted.status).toBe(200);

    // Une fois le compte créé, plus besoin du code pour se reconnecter.
    const relogin = await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'motdepasse1' } });
    expect(relogin.status).toBe(200);
  });

  it('réserve la gestion du code aux admins', async () => {
    const alice = await login('alice');
    expect((await call('POST', '/api/admin/invite-code', { cookie: alice.cookie, body: { code: 'X' } })).status).toBe(403);
  });

  it('un admin retire le code : l\'inscription redevient libre', async () => {
    const chef = await login('chef');
    await call('POST', '/api/admin/invite-code', { cookie: chef.cookie, body: { code: 'BIENVENUE' } });
    await call('POST', '/api/admin/invite-code', { cookie: chef.cookie, body: { code: '' } });
    expect((await call('GET', '/api/invite-required')).json).toEqual({ required: false });
    expect((await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'motdepasse1' } })).status).toBe(200);
  });

  it('vérifie un code sans créer de compte', async () => {
    const chef = await login('chef');
    await call('POST', '/api/admin/invite-code', { cookie: chef.cookie, body: { code: 'BIENVENUE' } });

    const bad = await call('POST', '/api/invite-code/check', { body: { code: 'FAUX' } });
    expect(bad.status).toBe(401);

    const good = await call('POST', '/api/invite-code/check', { body: { code: 'BIENVENUE' } });
    expect(good.status).toBe(200);
    expect(good.json.valid).toBe(true);
    // Rien n'a été créé : le pseudo n'est toujours pas pris.
    expect(Number(db.one("SELECT COUNT(*) AS n FROM users WHERE twitch_id LIKE 'dev:%' AND twitch_id NOT IN ('dev:chef')")?.n)).toBe(0);
  });

  it('signale un nouveau compte (isNew), pas une reconnexion', async () => {
    const created = await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'motdepasse1' } });
    expect(created.json.isNew).toBe(true);
    const again = await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'motdepasse1' } });
    expect(again.json.isNew).toBe(false);
  });
});

describe('administration', () => {
  it('réserve l\'attribution de boosters aux admins', async () => {
    const alice = await login('alice');
    const res = await call('POST', '/api/admin/grant', { cookie: alice.cookie, body: { userId: alice.id, amount: 3 } });
    expect(res.status).toBe(403);
  });

  it('un admin peut offrir des boosters, et l\'action est journalisée', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    const res = await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: alice.id, amount: 3 } });
    expect(res.status).toBe(200);
    expect(res.json.boosters).toBe(3);
    const log = db.one("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'grant_boosters'");
    expect(Number(log?.n)).toBe(1);
  });

  it('refuse les quantités absurdes', async () => {
    const chef = await login('chef');
    expect((await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: chef.id, amount: 0 } })).status).toBe(400);
    expect((await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: chef.id, amount: 101 } })).status).toBe(400);
    expect((await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: 9999, amount: 1 } })).status).toBe(404);
  });

  it('un admin peut offrir de la monnaie, et l\'action est journalisée', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    const res = await call('POST', '/api/admin/grant-currency', { cookie: chef.cookie, body: { userId: alice.id, amount: 50 } });
    expect(res.status).toBe(200);
    expect(res.json.currency).toBe(50);
    const me = await call('GET', '/api/me', { cookie: alice.cookie });
    expect(me.json.currency).toBe(50);
    const log = db.one("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'grant_currency'");
    expect(Number(log?.n)).toBe(1);
  });
});

describe('sanctions', () => {
  it('un admin bannit un joueur : sa session en cours est coupée et il ne peut plus se reconnecter', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    const res = await call('POST', `/api/admin/users/${alice.id}/ban`, { cookie: chef.cookie, body: { reason: 'triche' } });
    expect(res.status).toBe(200);

    const meAfter = await call('GET', '/api/me', { cookie: alice.cookie });
    expect(meAfter.status).toBe(403);
    expect(meAfter.json.error).toBe('banned');

    const relog = await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'password123' } });
    expect(relog.status).toBe(403);
    expect(relog.json.error).toBe('banned');
    expect(relog.json.message).toContain('triche');
  });

  it('un admin lève un bannissement', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    await call('POST', `/api/admin/users/${alice.id}/ban`, { cookie: chef.cookie, body: {} });
    await call('POST', `/api/admin/users/${alice.id}/unban`, { cookie: chef.cookie });
    const relog = await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'password123' } });
    expect(relog.status).toBe(200);
  });

  it('un admin ne peut pas se bannir lui-même', async () => {
    const chef = await login('chef');
    const res = await call('POST', `/api/admin/users/${chef.id}/ban`, { cookie: chef.cookie, body: {} });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('cannot_ban_self');
  });

  it('un admin ne peut pas bannir un autre admin', async () => {
    env.DEV_ADMINS = 'chef,superviseur';
    const chef = await login('chef');
    const superviseur = await login('superviseur');
    const res = await call('POST', `/api/admin/users/${superviseur.id}/ban`, { cookie: chef.cookie, body: {} });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('cannot_ban_admin');
  });

  it('réserve le bannissement aux admins', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    expect((await call('POST', `/api/admin/users/${bob.id}/ban`, { cookie: alice.cookie, body: {} })).status).toBe(403);
  });
});

describe('suppression de compte', () => {
  it('un admin supprime un joueur et tout ce qui s\'y rattache', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    const bob = await login('bob');
    give(alice.id, COMMUNE_A);
    give(bob.id, COMMUNE_B);
    await call('POST', '/api/trades', { cookie: alice.cookie, body: { toUserId: bob.id, offeredCardId: COMMUNE_A, requestedCardId: COMMUNE_B } });
    await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: alice.id, amount: 1 } });
    await call('POST', '/api/boosters/open', { cookie: alice.cookie });

    const res = await call('DELETE', `/api/admin/users/${alice.id}`, { cookie: chef.cookie });
    expect(res.status).toBe(200);

    expect(Number(db.one('SELECT COUNT(*) AS n FROM users WHERE id = ?', alice.id)?.n)).toBe(0);
    expect(Number(db.one('SELECT COUNT(*) AS n FROM collection WHERE user_id = ?', alice.id)?.n)).toBe(0);
    expect(Number(db.one('SELECT COUNT(*) AS n FROM openings WHERE user_id = ?', alice.id)?.n)).toBe(0);
    expect(Number(db.one('SELECT COUNT(*) AS n FROM trades WHERE from_user = ? OR to_user = ?', alice.id, alice.id)?.n)).toBe(0);
    // Bob n'est pas affecté par la suppression d'alice, sa carte n'a pas été touchée.
    expect(qty(bob.id, COMMUNE_B)).toEqual({ quantity: 1, reserved: 0 });
    // Le pseudo redevient disponible.
    expect((await call('POST', '/api/dev/login', { body: { name: 'alice', password: 'nouveaupass' } })).status).toBe(200);
  });

  it('un admin ne peut pas supprimer son propre compte', async () => {
    const chef = await login('chef');
    const res = await call('DELETE', `/api/admin/users/${chef.id}`, { cookie: chef.cookie });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('cannot_delete_self');
  });

  it('réserve la suppression de compte aux admins', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    expect((await call('DELETE', `/api/admin/users/${bob.id}`, { cookie: alice.cookie })).status).toBe(403);
  });

  it('refuse de supprimer un joueur inexistant', async () => {
    const chef = await login('chef');
    expect((await call('DELETE', '/api/admin/users/9999', { cookie: chef.cookie })).status).toBe(404);
  });
});

describe('codes de boosters', () => {
  it('un admin crée un code, et l\'action est journalisée', async () => {
    const chef = await login('chef');
    const res = await call('POST', '/api/admin/codes', { cookie: chef.cookie, body: { boosters: 3, maxUses: 10 } });
    expect(res.status).toBe(201);
    expect(res.json.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(res.json.boosters).toBe(3);
    expect(res.json.maxUses).toBe(10);
    expect(res.json.expiresAt).toBeNull();
    const log = db.one("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'create_code'");
    expect(Number(log?.n)).toBe(1);
  });

  it('un joueur ordinaire ne peut pas créer de code', async () => {
    const alice = await login('alice');
    const res = await call('POST', '/api/admin/codes', { cookie: alice.cookie, body: { boosters: 3, maxUses: 10 } });
    expect(res.status).toBe(403);
  });

  it('un joueur réclame un code et reçoit les boosters', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    const created = await call('POST', '/api/admin/codes', { cookie: chef.cookie, body: { boosters: 4, maxUses: 2 } });
    const res = await call('POST', '/api/codes/redeem', { cookie: alice.cookie, body: { code: created.json.code.toLowerCase() } });
    expect(res.status).toBe(200);
    expect(res.json.boostersLeft).toBe(4);
    expect(Number(db.one('SELECT boosters AS n FROM users WHERE id = ?', alice.id)?.n)).toBe(4);
  });

  it('un même joueur ne peut pas réclamer deux fois le même code', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    const created = await call('POST', '/api/admin/codes', { cookie: chef.cookie, body: { boosters: 2, maxUses: 10 } });
    expect((await call('POST', '/api/codes/redeem', { cookie: alice.cookie, body: { code: created.json.code } })).status).toBe(200);
    const second = await call('POST', '/api/codes/redeem', { cookie: alice.cookie, body: { code: created.json.code } });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe('code_already_used');
  });

  it('refuse un code au-delà de son nombre d\'utilisations, même en rafale', async () => {
    const chef = await login('chef');
    const created = await call('POST', '/api/admin/codes', { cookie: chef.cookie, body: { boosters: 1, maxUses: 2 } });
    const players = await Promise.all(['pa', 'pb', 'pc', 'pd'].map((n) => login(n)));
    const results = await Promise.all(
      players.map((p) => call('POST', '/api/codes/redeem', { cookie: p.cookie, body: { code: created.json.code } })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.json.error).toBe('code_exhausted');
  });

  it('refuse un code expiré', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    const created = await call('POST', '/api/admin/codes', { cookie: chef.cookie, body: { boosters: 1, maxUses: 5, expiresInHours: 1 } });
    db.exec(`UPDATE booster_codes SET expires_at = datetime('now', '-1 hour') WHERE code = '${created.json.code}'`);
    const res = await call('POST', '/api/codes/redeem', { cookie: alice.cookie, body: { code: created.json.code } });
    expect(res.status).toBe(410);
    expect(res.json.error).toBe('code_expired');
  });

  it('refuse un code inconnu', async () => {
    const alice = await login('alice');
    const res = await call('POST', '/api/codes/redeem', { cookie: alice.cookie, body: { code: 'INEXISTANT' } });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('code_not_found');
  });

  it('refuse des quantités ou durées absurdes', async () => {
    const chef = await login('chef');
    expect((await call('POST', '/api/admin/codes', { cookie: chef.cookie, body: { boosters: 0, maxUses: 1 } })).status).toBe(400);
    expect((await call('POST', '/api/admin/codes', { cookie: chef.cookie, body: { boosters: 1, maxUses: 0 } })).status).toBe(400);
    expect((await call('POST', '/api/admin/codes', { cookie: chef.cookie, body: { boosters: 101, maxUses: 1 } })).status).toBe(400);
  });
});

describe('vue d\'ensemble admin', () => {
  it('réserve la vue d\'ensemble aux admins', async () => {
    const alice = await login('alice');
    expect((await call('GET', '/api/admin/overview', { cookie: alice.cookie })).status).toBe(403);
  });

  it('renvoie des statistiques cohérentes', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: alice.id, amount: 2 } });
    await call('POST', '/api/boosters/open', { cookie: alice.cookie });

    const res = await call('GET', '/api/admin/overview', { cookie: chef.cookie });
    expect(res.status).toBe(200);
    expect(res.json.stats.totalUsers).toBe(2);
    expect(res.json.stats.totalOpenings).toBe(1);
    expect(res.json.adminLog.length).toBeGreaterThan(0);
    expect(Array.isArray(res.json.trades)).toBe(true);
    expect(Array.isArray(res.json.notableOpenings)).toBe(true);
  });

  it('la liste des stats joueurs est réservée aux admins et reflète leurs cartes/boosters', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    expect((await call('GET', '/api/admin/players', { cookie: alice.cookie })).status).toBe(403);

    await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: alice.id, amount: 4 } });
    give(alice.id, COMMUNE_A, 2);

    const res = await call('GET', '/api/admin/players', { cookie: chef.cookie });
    expect(res.status).toBe(200);
    const row = res.json.find((p: any) => p.displayName === 'alice');
    expect(row).toMatchObject({ boostersHeld: 4, distinctCards: 1, totalCards: 2, isBanned: 0 });
  });

  it('signale les tirages contenant une carte rare et plus, mais pas les tirages 100% communs', async () => {
    const chef = await login('chef');
    db.exec(`INSERT INTO openings (user_id, kind, card_ids) VALUES (${chef.id}, 'normal', '[1,2,3,4,${RARE}]')`);
    db.exec(`INSERT INTO openings (user_id, kind, card_ids) VALUES (${chef.id}, 'normal', '[1,2,3,4,5]')`);
    const res = await call('GET', '/api/admin/overview', { cookie: chef.cookie });
    expect(res.json.notableOpenings).toHaveLength(1);
    expect(res.json.notableOpenings[0]).toMatchObject({ userName: 'chef', cards: [{ name: 'Rare 01', rarity: 'rare' }] });
  });

  it('la liste des codes indique le bon créateur et le bon nombre d\'utilisations', async () => {
    const chef = await login('chef');
    const created = await call('POST', '/api/admin/codes', { cookie: chef.cookie, body: { boosters: 1, maxUses: 1 } });
    const list = await call('GET', '/api/admin/codes', { cookie: chef.cookie });
    expect(list.json[0]).toMatchObject({ code: created.json.code, createdByName: 'chef', uses: 0 });
  });
});

describe('profils', () => {
  it('valeurs par défaut à la création du compte', async () => {
    const alice = await login('alice');
    const res = await call('GET', `/api/users/${alice.id}/collection`, { cookie: alice.cookie });
    expect(res.json.user).toMatchObject({
      displayName: 'alice',
      avatarEmoji: '🙂',
      avatarColor: '#2b59c3',
      bio: '',
      distinctCards: 0,
      totalCards: 0,
      boostersOpened: 0,
      tradesCompleted: 0,
      featuredCard: null,
    });
  });

  it('les stats du profil reflètent boosters possédés, cartes et complétion de la série', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: alice.id, amount: 3 } });
    give(alice.id, COMMUNE_A, 2);
    give(alice.id, PEU_COMMUNE);
    const res = await call('GET', `/api/users/${alice.id}/collection`, { cookie: alice.cookie });
    expect(res.json.user).toMatchObject({
      boostersHeld: 3,
      distinctCards: 2,
      totalCards: 3,
      // 2 cartes différentes sur 100 non-secrètes (la carte secrète n'entre pas dans la complétion).
      completionPercent: 2,
    });
  });

  it('modifie son propre profil : icône, couleur, bio', async () => {
    const alice = await login('alice');
    const res = await call('POST', '/api/profile', {
      cookie: alice.cookie,
      body: { avatarEmoji: '🐉', avatarColor: '#b3261e', bio: 'Salut, je collectionne les rares.' },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ avatarEmoji: '🐉', avatarColor: '#b3261e', bio: 'Salut, je collectionne les rares.' });
  });

  it('refuse une icône ou une couleur hors de la liste', async () => {
    const alice = await login('alice');
    const bad1 = await call('POST', '/api/profile', { cookie: alice.cookie, body: { avatarEmoji: '💩', avatarColor: '#2b59c3', bio: '' } });
    expect(bad1.status).toBe(400);
    const bad2 = await call('POST', '/api/profile', { cookie: alice.cookie, body: { avatarEmoji: '🙂', avatarColor: '#000000', bio: '' } });
    expect(bad2.status).toBe(400);
  });

  it('refuse une bio trop longue', async () => {
    const alice = await login('alice');
    const res = await call('POST', '/api/profile', {
      cookie: alice.cookie,
      body: { avatarEmoji: '🙂', avatarColor: '#2b59c3', bio: 'x'.repeat(201) },
    });
    expect(res.status).toBe(400);
  });

  it('la carte vedette doit être possédée, et se reflète dans le profil public', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    const withoutCard = await call('POST', '/api/profile', {
      cookie: alice.cookie,
      body: { avatarEmoji: '🙂', avatarColor: '#2b59c3', bio: '', featuredCardId: RARE },
    });
    expect(withoutCard.status).toBe(409);
    expect(withoutCard.json.error).toBe('featured_not_owned');

    give(alice.id, RARE);
    const withCard = await call('POST', '/api/profile', {
      cookie: alice.cookie,
      body: { avatarEmoji: '🙂', avatarColor: '#2b59c3', bio: '', featuredCardId: RARE },
    });
    expect(withCard.status).toBe(200);
    expect(withCard.json.featuredCard).toMatchObject({ id: RARE, name: 'Rare 01', rarity: 'rare' });

    const seenByBob = await call('GET', `/api/users/${alice.id}/collection`, { cookie: bob.cookie });
    expect(seenByBob.json.user.featuredCard).toMatchObject({ id: RARE, name: 'Rare 01', rarity: 'rare' });
  });

  it('une carte vedette perdue (échangée) disparaît du profil sans erreur', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    give(alice.id, RARE);
    give(bob.id, 87); // une autre rare, pour l'échange
    await call('POST', '/api/profile', { cookie: alice.cookie, body: { avatarEmoji: '🙂', avatarColor: '#2b59c3', bio: '', featuredCardId: RARE } });

    const trade = await call('POST', '/api/trades', { cookie: alice.cookie, body: { toUserId: bob.id, offeredCardId: RARE, requestedCardId: 87 } });
    await call('POST', `/api/trades/${trade.json.id}/accept`, { cookie: bob.cookie });

    const res = await call('GET', `/api/users/${alice.id}/collection`, { cookie: alice.cookie });
    expect(res.status).toBe(200);
    expect(res.json.user.featuredCard).toBeNull();
  });

  it('les statistiques du profil reflètent boosters, cartes et échanges', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: alice.id, amount: 2 } });
    await call('POST', '/api/boosters/open', { cookie: alice.cookie });
    give(alice.id, COMMUNE_A);
    give(chef.id, COMMUNE_B);
    const trade = await call('POST', '/api/trades', { cookie: alice.cookie, body: { toUserId: chef.id, offeredCardId: COMMUNE_A, requestedCardId: COMMUNE_B } });
    await call('POST', `/api/trades/${trade.json.id}/accept`, { cookie: chef.cookie });

    const res = await call('GET', `/api/users/${alice.id}/collection`, { cookie: alice.cookie });
    expect(res.json.user.boostersOpened).toBe(1);
    expect(res.json.user.tradesCompleted).toBe(1);
    expect(res.json.user.totalCards).toBeGreaterThanOrEqual(5);
  });

  it('expose les icônes et couleurs disponibles', async () => {
    const alice = await login('alice');
    const res = await call('GET', '/api/profile/options', { cookie: alice.cookie });
    expect(res.status).toBe(200);
    expect(res.json.emojis).toContain('🙂');
    expect(res.json.colors).toContain('#2b59c3');
    expect(res.json.maxBioLength).toBe(200);
  });

  it('la liste des joueurs inclut l\'icône de profil', async () => {
    const alice = await login('alice');
    await call('POST', '/api/profile', { cookie: alice.cookie, body: { avatarEmoji: '🦊', avatarColor: '#3b6fd4', bio: '' } });
    const res = await call('GET', '/api/users', { cookie: alice.cookie });
    expect(res.json.find((p: any) => p.id === alice.id)).toMatchObject({ avatarEmoji: '🦊', avatarColor: '#3b6fd4' });
  });
});

describe('ouverture de boosters', () => {
  it('ouvre un booster : 5 cartes ajoutées, stock réduit de 1', async () => {
    const chef = await login('chef');
    await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: chef.id, amount: 2 } });

    const res = await call('POST', '/api/boosters/open', { cookie: chef.cookie });
    expect(res.status).toBe(200);
    expect(res.json.cards).toHaveLength(5);
    expect(res.json.boostersLeft).toBe(1);

    const total = db.one('SELECT SUM(quantity) AS n FROM collection WHERE user_id = ?', chef.id);
    expect(Number(total?.n)).toBe(5);
    expect(Number(db.one('SELECT COUNT(*) AS n FROM openings')?.n)).toBe(1);

    const collection = await call('GET', '/api/collection', { cookie: chef.cookie });
    expect(collection.json.reduce((s: number, c: any) => s + c.quantity, 0)).toBe(5);
  });

  it('sans booster : refus, et aucune carte ajoutée', async () => {
    const alice = await login('alice');
    const res = await call('POST', '/api/boosters/open', { cookie: alice.cookie });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('no_booster');
    expect(Number(db.one('SELECT COUNT(*) AS n FROM collection')?.n)).toBe(0);
    expect(Number(db.one('SELECT COUNT(*) AS n FROM openings')?.n)).toBe(0);
  });

  it('ne peut pas ouvrir plus de boosters que le stock, même en rafale', async () => {
    const chef = await login('chef');
    await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: chef.id, amount: 3 } });
    const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/boosters/open', { cookie: chef.cookie })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(Number(db.one('SELECT SUM(quantity) AS n FROM collection WHERE user_id = ?', chef.id)?.n)).toBe(15);
    expect(Number(db.one('SELECT boosters AS n FROM users WHERE id = ?', chef.id)?.n)).toBe(0);
  });

  it('liste l\'historique de ses propres ouvertures, plus récentes d\'abord', async () => {
    const chef = await login('chef');
    const alice = await login('alice');
    await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: chef.id, amount: 2 } });
    await call('POST', '/api/admin/grant', { cookie: chef.cookie, body: { userId: alice.id, amount: 1 } });
    const first = await call('POST', '/api/boosters/open', { cookie: chef.cookie });
    const second = await call('POST', '/api/boosters/open', { cookie: chef.cookie });
    await call('POST', '/api/boosters/open', { cookie: alice.cookie });

    const res = await call('GET', '/api/boosters/openings', { cookie: chef.cookie });
    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(2);
    expect(res.json[0].cards).toEqual(second.json.cards);
    expect(res.json[1].cards).toEqual(first.json.cards);
  });
});

describe('échanges', () => {
  let alice: { cookie: string; id: number };
  let bob: { cookie: string; id: number };

  beforeEach(async () => {
    alice = await login('alice');
    bob = await login('bob');
    give(alice.id, COMMUNE_A);
    give(bob.id, COMMUNE_B);
  });

  const propose = (cookie: string, toUserId: number, offeredCardId: number, requestedCardId: number) =>
    call('POST', '/api/trades', { cookie, body: { toUserId, offeredCardId, requestedCardId } });

  it('propose : la carte offerte est réservée', async () => {
    const res = await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    expect(res.status).toBe(201);
    expect(qty(alice.id, COMMUNE_A)).toEqual({ quantity: 1, reserved: 1 });
  });

  it('accepte : les deux cartes changent de main, les réservations sont libérées', async () => {
    const { json } = await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    const res = await call('POST', `/api/trades/${json.id}/accept`, { cookie: bob.cookie });
    expect(res.status).toBe(200);
    expect(qty(alice.id, COMMUNE_A).quantity).toBe(0);
    expect(qty(alice.id, COMMUNE_B).quantity).toBe(1);
    expect(qty(bob.id, COMMUNE_B).quantity).toBe(0);
    expect(qty(bob.id, COMMUNE_A).quantity).toBe(1);
    expect(qty(alice.id, COMMUNE_A).reserved).toBe(0);
    const status = db.one('SELECT status FROM trades WHERE id = ?', json.id);
    expect(status?.status).toBe('accepted');
  });

  it('ne conserve aucune carte perdue ou dupliquée : le total reste constant', async () => {
    const before = Number(db.one('SELECT SUM(quantity) AS n FROM collection')?.n);
    const { json } = await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    await call('POST', `/api/trades/${json.id}/accept`, { cookie: bob.cookie });
    expect(Number(db.one('SELECT SUM(quantity) AS n FROM collection')?.n)).toBe(before);
  });

  it('refuse deux raretés différentes', async () => {
    give(bob.id, PEU_COMMUNE);
    const res = await propose(alice.cookie, bob.id, COMMUNE_A, PEU_COMMUNE);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('rarity_mismatch');
    expect(qty(alice.id, COMMUNE_A).reserved).toBe(0);
  });

  it('refuse la carte secrète', async () => {
    give(alice.id, SECRETE);
    give(bob.id, SECRETE);
    const res = await propose(alice.cookie, bob.id, SECRETE, SECRETE);
    expect(res.status).toBe(400);
    // même carte des deux côtés OU non échangeable : dans les deux cas c'est refusé
    expect(['same_card', 'not_tradable']).toContain(res.json.error);
  });

  it('refuse la carte secrète contre une autre carte, avec le bon motif', async () => {
    give(alice.id, SECRETE);
    const res = await propose(alice.cookie, bob.id, SECRETE, COMMUNE_B);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('not_tradable');
  });

  it('refuse d\'offrir une carte qu\'on ne possède pas', async () => {
    const res = await propose(alice.cookie, bob.id, COMMUNE_B, COMMUNE_A);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('not_owned');
  });

  it('refuse de demander une carte que l\'autre ne possède pas', async () => {
    give(alice.id, PEU_COMMUNE);
    const res = await propose(alice.cookie, bob.id, PEU_COMMUNE, 52);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('target_not_owned');
  });

  it('refuse un échange avec soi-même', async () => {
    const res = await propose(alice.cookie, alice.id, COMMUNE_A, COMMUNE_B);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('self_trade');
  });

  it('un seul exemplaire ne peut pas être offert dans deux demandes', async () => {
    give(bob.id, 3);
    give(bob.id, 4);
    expect((await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B)).status).toBe(201);
    const second = await propose(alice.cookie, bob.id, COMMUNE_A, 3);
    expect(second.status).toBe(409);
    expect(second.json.error).toBe('not_owned');
    expect(qty(alice.id, COMMUNE_A)).toEqual({ quantity: 1, reserved: 1 });
  });

  it('seul le destinataire peut accepter ou refuser', async () => {
    const { json } = await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    const byAuthor = await call('POST', `/api/trades/${json.id}/accept`, { cookie: alice.cookie });
    expect(byAuthor.status).toBe(403);
    const carol = await login('carol');
    const byOther = await call('POST', `/api/trades/${json.id}/decline`, { cookie: carol.cookie });
    expect(byOther.status).toBe(403);
    expect(db.one('SELECT status FROM trades WHERE id = ?', json.id)?.status).toBe('pending');
    expect(qty(alice.id, COMMUNE_A).quantity).toBe(1);
  });

  it('seul l\'auteur peut annuler, et la carte est libérée', async () => {
    const { json } = await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    expect((await call('POST', `/api/trades/${json.id}/cancel`, { cookie: bob.cookie })).status).toBe(403);
    expect((await call('POST', `/api/trades/${json.id}/cancel`, { cookie: alice.cookie })).status).toBe(200);
    expect(qty(alice.id, COMMUNE_A)).toEqual({ quantity: 1, reserved: 0 });
  });

  it('un refus libère la carte offerte', async () => {
    const { json } = await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    expect((await call('POST', `/api/trades/${json.id}/decline`, { cookie: bob.cookie })).status).toBe(200);
    expect(qty(alice.id, COMMUNE_A)).toEqual({ quantity: 1, reserved: 0 });
    expect(qty(bob.id, COMMUNE_B).quantity).toBe(1);
  });

  it('une demande ne peut être conclue qu\'une seule fois, même en rafale', async () => {
    const { json } = await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    const results = await Promise.all([
      call('POST', `/api/trades/${json.id}/accept`, { cookie: bob.cookie }),
      call('POST', `/api/trades/${json.id}/accept`, { cookie: bob.cookie }),
      call('POST', `/api/trades/${json.id}/accept`, { cookie: bob.cookie }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.json.error).toBe('trade_closed');
    expect(qty(bob.id, COMMUNE_A).quantity).toBe(1);
    expect(qty(alice.id, COMMUNE_B).quantity).toBe(1);
  });

  it('une demande acceptée ne peut plus être refusée, et inversement', async () => {
    const a = await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    await call('POST', `/api/trades/${a.json.id}/accept`, { cookie: bob.cookie });
    const declineAfterAccept = await call('POST', `/api/trades/${a.json.id}/decline`, { cookie: bob.cookie });
    expect(declineAfterAccept.status).toBe(409);
    expect(declineAfterAccept.json.error).toBe('trade_closed');

    // Nouvelle demande, refusée puis tentative d'acceptation
    give(alice.id, 3);
    give(bob.id, 4);
    const b = await propose(alice.cookie, bob.id, 3, 4);
    await call('POST', `/api/trades/${b.json.id}/decline`, { cookie: bob.cookie });
    const acceptAfterDecline = await call('POST', `/api/trades/${b.json.id}/accept`, { cookie: bob.cookie });
    expect(acceptAfterDecline.status).toBe(409);
    expect(acceptAfterDecline.json.error).toBe('trade_closed');
    expect(qty(alice.id, 3).quantity).toBe(1);
    expect(qty(bob.id, 4).quantity).toBe(1);
  });

  it('une demande annulée ne peut pas être annulée deux fois', async () => {
    const a = await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    expect((await call('POST', `/api/trades/${a.json.id}/cancel`, { cookie: alice.cookie })).status).toBe(200);
    const again = await call('POST', `/api/trades/${a.json.id}/cancel`, { cookie: alice.cookie });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('trade_closed');
    // La réservation n'a pas été libérée deux fois
    expect(qty(alice.id, COMMUNE_A)).toEqual({ quantity: 1, reserved: 0 });
  });

  it('accepter échoue proprement, sans rien modifier, si le destinataire n\'a plus la carte', async () => {
    const { json } = await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    db.exec(`UPDATE collection SET quantity = 0 WHERE user_id = ${bob.id} AND card_id = ${COMMUNE_B}`);
    const res = await call('POST', `/api/trades/${json.id}/accept`, { cookie: bob.cookie });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('target_not_owned');
    expect(db.one('SELECT status FROM trades WHERE id = ?', json.id)?.status).toBe('pending');
    expect(qty(alice.id, COMMUNE_A)).toEqual({ quantity: 1, reserved: 1 });
    expect(Number(db.one('SELECT COUNT(*) AS n FROM trade_resolutions')?.n)).toBe(0);
  });

  it('le destinataire ne peut pas accepter avec un exemplaire déjà réservé dans sa propre demande', async () => {
    give(alice.id, 3);
    const first = await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    // Bob réserve son unique exemplaire de COMMUNE_B dans sa propre demande
    const second = await propose(bob.cookie, alice.id, COMMUNE_B, 3);
    expect(second.status).toBe(201);
    const res = await call('POST', `/api/trades/${first.json.id}/accept`, { cookie: bob.cookie });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('target_not_owned');
    expect(qty(bob.id, COMMUNE_B)).toEqual({ quantity: 1, reserved: 1 });
  });

  it('liste les demandes reçues et envoyées', async () => {
    await propose(alice.cookie, bob.id, COMMUNE_A, COMMUNE_B);
    const forBob = await call('GET', '/api/trades', { cookie: bob.cookie });
    expect(forBob.json).toHaveLength(1);
    expect(forBob.json[0]).toMatchObject({ fromName: 'alice', toName: 'bob', status: 'pending' });
    const forCarol = await call('GET', '/api/trades', { cookie: (await login('carol')).cookie });
    expect(forCarol.json).toHaveLength(0);
  });

  it('les collections sont visibles par les autres joueurs', async () => {
    const res = await call('GET', `/api/users/${bob.id}/collection`, { cookie: alice.cookie });
    expect(res.status).toBe(200);
    expect(res.json.cards).toMatchObject([{ cardId: COMMUNE_B, quantity: 1 }]);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index.ts';
import { FakeD1 } from './fakeD1.ts';
import { startRun, submitScore, getLeaderboard, randomPseudo, maxPlausibleScore } from '../src/suikamon.ts';
import { seededRng } from '../src/rng.ts';

const SECRET = 'secret-de-test';
const T0 = 1_800_000_000_000;
const joueur = (n: number) => n.toString(16).padStart(32, '0');

let db: FakeD1;
beforeEach(() => { db = new FakeD1(); });

/** Une partie de `secondes` secondes qui rapporte `score`, envoyée par le joueur n. */
async function partie(n: number, score: number, secondes = 120) {
  const run = await startRun(SECRET, T0);
  return submitScore(db as unknown as D1Database, SECRET, { run, score, player: joueur(n) }, T0 + secondes * 1000);
}

describe('pseudos', () => {
  it('sont aléatoires, lisibles et sans espace en trop', () => {
    const rng = seededRng(1);
    const vus = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = randomPseudo(rng);
      expect(p).toMatch(/^[^\s].+ \d{3}$/);
      vus.add(p);
    }
    expect(vus.size).toBeGreaterThan(150);
  });
});

describe('envoi de score', () => {
  it('enregistre un premier score et attribue un pseudo', async () => {
    const r = await partie(1, 500);
    expect(r).toMatchObject({ score: 500, rank: 1, improved: true });
    expect(r.pseudo.length).toBeGreaterThan(5);
  });

  it("ne garde que le meilleur score et conserve le pseudo", async () => {
    const a = await partie(1, 800);
    const b = await partie(1, 300);
    expect(b).toMatchObject({ score: 800, improved: false, pseudo: a.pseudo });
    const c = await partie(1, 900);
    expect(c).toMatchObject({ score: 900, improved: true, pseudo: a.pseudo });
  });

  it('refuse un jeton falsifié ou venant d\'un autre secret', async () => {
    const run = await startRun('autre-secret', T0);
    await expect(submitScore(db as unknown as D1Database, SECRET, { run, score: 10, player: joueur(1) }, T0 + 60_000))
      .rejects.toMatchObject({ code: 'bad_run' });
    const vrai = await startRun(SECRET, T0);
    const triche = vrai.replace(/\.\d+\./, `.${Math.floor(T0 / 1000) - 99999}.`);
    await expect(submitScore(db as unknown as D1Database, SECRET, { run: triche, score: 10, player: joueur(1) }, T0 + 60_000))
      .rejects.toMatchObject({ code: 'bad_run' });
    await expect(submitScore(db as unknown as D1Database, SECRET, { run: 'n-importe-quoi', score: 10, player: joueur(1) }, T0))
      .rejects.toMatchObject({ code: 'bad_run' });
  });

  it('un jeton ne sert qu\'une fois', async () => {
    const run = await startRun(SECRET, T0);
    const envoi = () => submitScore(db as unknown as D1Database, SECRET, { run, score: 100, player: joueur(1) }, T0 + 60_000);
    await envoi();
    await expect(envoi()).rejects.toMatchObject({ code: 'run_used', status: 409 });
  });

  it('refuse une partie trop courte, trop ancienne, ou un score trop beau pour sa durée', async () => {
    await expect(partie(1, 50, 3)).rejects.toMatchObject({ code: 'run_too_short' });
    await expect(partie(1, 50, 7 * 3600)).rejects.toMatchObject({ code: 'run_expired' });
    await expect(partie(1, maxPlausibleScore(120) + 1, 120)).rejects.toMatchObject({ code: 'score_implausible' });
    expect((await partie(1, maxPlausibleScore(120), 120)).score).toBe(maxPlausibleScore(120));
  });

  it('refuse les scores et clés de joueur invalides, sans consommer le jeton', async () => {
    const run = await startRun(SECRET, T0);
    const essai = (score: unknown, player: unknown) =>
      submitScore(db as unknown as D1Database, SECRET, { run, score, player }, T0 + 60_000);
    for (const score of [0, -5, 1.5, '100', null, 10 ** 9]) {
      await expect(essai(score, joueur(1))).rejects.toMatchObject({ code: 'bad_request' });
    }
    for (const player of [undefined, 'court', joueur(10).toUpperCase(), 'z'.repeat(32)]) {
      await expect(essai(100, player)).rejects.toMatchObject({ code: 'bad_request' });
    }
    await expect(essai(100, joueur(1))).resolves.toMatchObject({ score: 100 });
  });
});

describe('classement', () => {
  it('trie par score, partage le rang des ex æquo et ne révèle jamais les clés des joueurs', async () => {
    await partie(1, 300); await partie(2, 900); await partie(3, 900); await partie(4, 100);
    const lb = await getLeaderboard(db as unknown as D1Database, joueur(4));
    expect(lb.top.map((r) => [r.rank, r.score])).toEqual([[1, 900], [1, 900], [3, 300], [4, 100]]);
    expect(lb.players).toBe(4);
    expect(lb.me).toMatchObject({ score: 100, rank: 4 });
    expect(JSON.stringify(lb)).not.toContain(joueur(2));
    expect(Object.keys(lb.top[0]).sort()).toEqual(['pseudo', 'rank', 'score']);
  });

  it('limite l\'affichage à 20 lignes mais donne quand même son rang à un joueur plus bas', async () => {
    for (let i = 1; i <= 25; i++) await partie(i, i * 10);
    const lb = await getLeaderboard(db as unknown as D1Database, joueur(1));
    expect(lb.top).toHaveLength(20);
    expect(lb.players).toBe(25);
    expect(lb.me).toMatchObject({ score: 10, rank: 25 });
  });

  it('ne plante pas pour un joueur inconnu ou une clé mal formée', async () => {
    expect((await getLeaderboard(db as unknown as D1Database, joueur(9))).me).toBeNull();
    expect((await getLeaderboard(db as unknown as D1Database, "' OR 1=1 --")).me).toBeNull();
  });
});

describe('API Suikamon', () => {
  it('parcours complet : jeton, refus trop tôt, classement public sans connexion', async () => {
    const env = { DB: db, SESSION_SECRET: SECRET };
    const post = (path: string, body?: unknown) =>
      app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
    const { run } = await (await post('/api/suikamon/run')).json() as { run: string };
    const trop = await post('/api/suikamon/scores', { run, score: 10, player: joueur(1) });
    expect(trop.status).toBe(422);
    expect((await trop.json() as { error: string }).error).toBe('run_too_short');
    const lb = await app.request('/api/suikamon/leaderboard', {}, env);
    expect(lb.status).toBe(200);
    expect(await lb.json()).toEqual({ top: [], players: 0, me: null });
  });
});

/**
 * Vérification de bout en bout contre un Worker qui tourne (en local ou déployé pour test).
 *
 *   npm run smoke                              # http://localhost:8787
 *   npm run smoke -- https://mon-test.example  # une autre adresse
 *
 * Le Worker doit avoir DEV_AUTH=1 et "admin" dans DEV_ADMINS (connexion de test).
 * Si DEV_PASSWORD est défini, le passer avec :  DEV_PASSWORD=... npm run smoke
 */
const BASE = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const PASSWORD = process.env.DEV_PASSWORD;
const suffix = Math.random().toString(36).slice(2, 7);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : ' ÉCHEC'}  ${label}${ok ? '' : ' -> ' + detail}`);
  if (!ok) failures++;
};

async function api(method, path, { body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* pas du JSON */ }
  return { status: res.status, json, cookie: res.headers.getSetCookie?.()[0]?.split(';')[0] };
}

async function login(name) {
  const res = await api('POST', '/api/dev/login', { body: { name, ...(PASSWORD ? { password: PASSWORD } : {}) } });
  if (res.status !== 200) throw new Error(`Connexion impossible pour ${name} : ${res.status} ${JSON.stringify(res.json)}`);
  return { cookie: res.cookie, id: res.json.id };
}

const admin = await login('admin');
const alice = await login(`alice-${suffix}`);
const bob = await login(`bob-${suffix}`);
console.log(`Vérification de ${BASE}\n`);

// --- Boosters ---------------------------------------------------------------
let r = await api('POST', '/api/boosters/open', { cookie: alice.cookie });
check('ouvrir sans booster est refusé (no_booster)', r.status === 409 && r.json?.error === 'no_booster', JSON.stringify(r.json));

for (const who of [alice, bob]) {
  r = await api('POST', '/api/admin/grant', { cookie: admin.cookie, body: { userId: who.id, amount: 6 } });
  check('un admin offre 6 boosters', r.status === 200 && r.json.boosters === 6, JSON.stringify(r.json));
}
r = await api('POST', '/api/admin/grant', { cookie: alice.cookie, body: { userId: alice.id, amount: 6 } });
check("un joueur ordinaire ne peut pas s'offrir de boosters", r.status === 403, String(r.status));

let total = 0;
for (let i = 0; i < 6; i++) {
  r = await api('POST', '/api/boosters/open', { cookie: alice.cookie });
  if (r.status !== 200 || r.json.cards.length !== 5) { check('ouvrir un booster', false, JSON.stringify(r.json)); break; }
  total += 5;
  await api('POST', '/api/boosters/open', { cookie: bob.cookie });
}
r = await api('GET', '/api/collection', { cookie: alice.cookie });
const aliceCards = r.json;
check('6 boosters ouverts = 30 cartes en collection', aliceCards.reduce((s, c) => s + c.quantity, 0) === total, String(aliceCards.reduce((s, c) => s + c.quantity, 0)));
r = await api('GET', '/api/me', { cookie: alice.cookie });
check('le stock de boosters est à 0', r.json.boosters === 0, JSON.stringify(r.json));
r = await api('POST', '/api/boosters/open', { cookie: alice.cookie });
check('un 7e booster est refusé', r.status === 409, String(r.status));

// --- Échanges ---------------------------------------------------------------
r = await api('GET', `/api/users/${bob.id}/collection`, { cookie: alice.cookie });
const bobCards = r.json.cards;

// Une paire de même rareté, avec des cartes différentes, tradable des deux côtés
const pair = (() => {
  for (const a of aliceCards) for (const b of bobCards) {
    if (a.rarity === b.rarity && a.cardId !== b.cardId && a.tradable && b.tradable) return { a, b };
  }
  return null;
})();
check('les deux joueurs ont une paire de même rareté à échanger', !!pair);

if (pair) {
  const other = bobCards.find((c) => c.rarity !== pair.a.rarity && c.tradable);
  if (other) {
    r = await api('POST', '/api/trades', { cookie: alice.cookie, body: { toUserId: bob.id, offeredCardId: pair.a.cardId, requestedCardId: other.cardId } });
    check('deux raretés différentes sont refusées (rarity_mismatch)', r.status === 400 && r.json?.error === 'rarity_mismatch', JSON.stringify(r.json));
  }

  r = await api('POST', '/api/trades', { cookie: alice.cookie, body: { toUserId: bob.id, offeredCardId: pair.a.cardId, requestedCardId: pair.b.cardId } });
  check('proposer un échange', r.status === 201, JSON.stringify(r.json));
  const tradeId = r.json?.id;

  r = await api('POST', `/api/trades/${tradeId}/accept`, { cookie: alice.cookie });
  check("l'auteur ne peut pas accepter sa propre demande", r.status === 403, String(r.status));

  r = await api('POST', `/api/trades/${tradeId}/accept`, { cookie: bob.cookie });
  check('le destinataire accepte', r.status === 200, JSON.stringify(r.json));
  r = await api('POST', `/api/trades/${tradeId}/accept`, { cookie: bob.cookie });
  check('accepter une seconde fois est refusé (trade_closed)', r.status === 409 && r.json?.error === 'trade_closed', JSON.stringify(r.json));
  r = await api('POST', `/api/trades/${tradeId}/decline`, { cookie: bob.cookie });
  check('refuser une demande déjà acceptée est refusé (trade_closed)', r.status === 409 && r.json?.error === 'trade_closed', JSON.stringify(r.json));

  const aliceAfter = (await api('GET', '/api/collection', { cookie: alice.cookie })).json;
  const bobAfter = (await api('GET', '/api/collection', { cookie: bob.cookie })).json;
  const count = (list, id) => list.find((c) => c.cardId === id)?.quantity ?? 0;
  check('la carte offerte est passée de alice à bob', count(aliceAfter, pair.a.cardId) === pair.a.quantity - 1 && count(bobAfter, pair.a.cardId) >= 1);
  check('la carte demandée est passée de bob à alice', count(bobAfter, pair.b.cardId) === bobCards.find((c) => c.cardId === pair.b.cardId).quantity - 1 && count(aliceAfter, pair.b.cardId) >= 1);
  check('aucune carte perdue ni dupliquée', aliceAfter.reduce((s, c) => s + c.quantity, 0) === total && bobAfter.reduce((s, c) => s + c.quantity, 0) === total);
  check("plus rien n'est réservé", [...aliceAfter, ...bobAfter].every((c) => c.reserved === 0));
}

console.log(failures === 0 ? '\nTout est bon.' : `\n${failures} vérification(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);

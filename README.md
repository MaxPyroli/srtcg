# TCG de la communauté : le moteur (phase 1)

Jeu de cartes à collectionner en ligne : **boosters**, **collection**, **échanges**.
Tourne sur Cloudflare (Workers + base D1), gratuit pour la phase de test.
Le combat, la connexion Twitch et le design viendront ensuite.

## Ce qui est fait

- Ouverture de boosters côté serveur : 3 communes, une carte 4 qui peut être meilleure,
  une carte 5 d'au moins peu commune, carte secrète (1 sur 1000), God Pack (1 sur 2000).
  Les probabilités sont dans `src/config.ts`.
- Collection de chaque joueur, visible par tous.
- Échanges asynchrones entre cartes de **même rareté** : demande, acceptation, refus, annulation.
  La carte offerte est bloquée pendant l'attente. La carte secrète n'est pas échangeable.
- Compte admin : offrir des boosters (action journalisée).
- Page de test pour tout essayer (`public/index.html`), sobre : le design viendra avec l'univers.
- Catalogue provisoire de 101 cartes (50 / 35 / 10 / 5 + 1 secrète), à renommer plus tard.

## Essayer chez toi (sur ton ordinateur)

Il faut [Node.js](https://nodejs.org) version 22 ou plus.

```bash
npm install
cp .dev.vars.example .dev.vars     # réglages locaux (sous Windows : copy .dev.vars.example .dev.vars)
npm run db:local                   # crée la base locale avec les 101 cartes
npm run dev                        # démarre le jeu sur http://localhost:8787
```

Ouvre `http://localhost:8787`, connecte-toi avec le pseudo **admin** (c'est l'administrateur),
offre-toi des boosters dans l'onglet Administration, puis ouvre-les. Pour tester un échange,
ouvre une seconde fenêtre de navigation privée et connecte-toi avec un autre pseudo.

## Vérifier que tout fonctionne

```bash
npm test            # 40 tests : tirage, règles d'échange, sécurité
npm run typecheck   # vérifie le code TypeScript
npm run simulate    # combien de boosters pour compléter la série ? (utilise le vrai tirage)
npm run smoke       # parcours complet contre le serveur lancé par « npm run dev »
```

## Mettre un test en ligne sur Cloudflare

1. `npx wrangler login` (ouvre le navigateur pour se connecter à Cloudflare)
2. `npx wrangler d1 create tcg-communaute` puis copier le `database_id` affiché dans `wrangler.jsonc`
3. `npm run db:remote` (crée les tables et les cartes en ligne)
4. Générer puis enregistrer la clé qui signe les sessions :
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   npx wrangler secret put SESSION_SECRET      # coller la valeur générée
   ```
5. Pour un **test privé uniquement**, activer la connexion de test :
   dans `wrangler.jsonc`, passer `"DEV_AUTH"` à `"1"` et ajouter `"DEV_ADMINS": "admin"` dans `vars`,
   puis protéger l'accès : `npx wrangler secret put DEV_PASSWORD`.
6. `npm run deploy`

> **Attention** : la connexion de test permet de se faire passer pour n'importe quel joueur.
> Elle est coupée par défaut et doit rester coupée dès que le jeu est ouvert à la communauté.
> Elle sera remplacée par la connexion Twitch.

Le rattachement du nom de domaine se fait ensuite dans Cloudflare (Workers, réglages du Worker,
domaines personnalisés). Le plus simple est que le DNS du domaine soit géré par Cloudflare.

### Déploiement automatique à chaque push (optionnel)

Jusqu'ici, la mise en ligne se fait à la main (`npm run deploy`). Pour que Cloudflare déploie automatiquement
à chaque `git push` (avec des liens de test par branche), il faut connecter le dépôt GitHub depuis le tableau
de bord Cloudflare — cette étape demande une autorisation interactive et ne peut pas être automatisée :

1. Dans le [tableau de bord Cloudflare](https://dash.cloudflare.com), ouvrir **Workers & Pages** → le Worker
   `tcg-communaute` → **Settings** → **Builds** → **Connect**.
2. Autoriser l'accès Cloudflare au dépôt GitHub `MaxPyroli/srtcg` (installation de l'app GitHub Cloudflare Workers).
3. Vérifier la configuration proposée (commande de build : aucune, ce projet n'en a pas besoin ; commande de
   déploiement : `npx wrangler deploy`).
4. Les secrets (`SESSION_SECRET`, `DEV_PASSWORD`) doivent être redéfinis dans **Settings → Variables and Secrets**
   du Worker si ce n'est pas déjà fait ailleurs : les secrets ne sont jamais lus depuis `wrangler.jsonc` ou le dépôt.

Une fois connecté, chaque `git push` sur la branche principale redéploie automatiquement, et les autres
branches obtiennent un lien de prévisualisation.

## Comment c'est construit

```
src/config.ts      probabilités et réglages du jeu
src/draw.ts        tirage d'un booster (fonction pure, testée)
src/rng.ts         aléatoire sécurisé (et reproductible pour les tests)
src/db.ts          base de données : boosters, collection, échanges, admin
src/auth.ts        sessions par cookie signé
src/index.ts       les routes de l'API
migrations/        schéma de la base (0001) et catalogue provisoire (0002)
public/index.html  page de test
test/              tests (fausse base D1 identique à la vraie sur les lots atomiques)
scripts/           simulation et vérification de bout en bout
```

### Pourquoi les règles sont dans la base

La base D1 n'a pas de transactions classiques (BEGIN / COMMIT). Un lot d'instructions est en
revanche exécuté comme une seule transaction, annulée en entier si une instruction échoue, mais
seulement quand la base lève une erreur. Les règles du jeu sont donc écrites dans la base
(contraintes et déclencheurs de `migrations/0001_init.sql`) : stock de boosters jamais négatif,
même rareté, cartes réellement possédées, une demande conclue une seule fois. Ainsi, aucune carte
ne peut être perdue ou dupliquée, même si deux requêtes arrivent en même temps.

## Choix faits en route (à confirmer ou changer)

- Dans un God Pack, les 3 rares sont différentes. Dans un booster normal, une même carte peut sortir deux fois.
- La carte secrète prend la place de la carte 5 ; elle n'est pas échangeable.
- Pour proposer un échange, il faut que l'autre joueur possède la carte demandée.
- Pas de limite du nombre de demandes d'échange par jour pour l'instant.

## Limites du plan gratuit Cloudflare

100 000 requêtes par jour ; base : 5 millions de lignes lues et 100 000 écrites par jour, 5 Go.
Largement suffisant pour tester. Surveiller la consommation dans le tableau de bord Cloudflare.

## Ce qui reste à faire

Connexion Twitch et statut follow / abonné · notifications d'abonnement · codes de boosters et
événements · monnaie interne · vrais noms et images des cartes · combat (phase 2).

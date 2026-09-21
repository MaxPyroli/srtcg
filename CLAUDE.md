# TCG de la communauté : contexte du projet

Ce fichier est lu au début de chaque session. Il résume ce qui a été décidé avec le propriétaire du projet
avant que le travail passe dans Claude Code. En cas de doute sur une règle du jeu, la demander plutôt que
la deviner : les décisions de jeu appartiennent au propriétaire.

## Le projet

Jeu de cartes à collectionner (TCG) en ligne, jouable dans le navigateur, pour la communauté Twitch du
propriétaire (petite pour l'instant). Très inspiré de Pokémon TCG Pocket. **Entièrement gratuit, aucun argent
réel, aucun achat.** L'univers, les noms et les illustrations des cartes ne sont pas choisis : c'est une partie
artistique qui viendra après le fonctionnement. Les 101 cartes actuelles sont des marqueurs provisoires.

## Les trois piliers, par priorité

1. **Ouverture de boosters** (le moment de plaisir : animation soignée à prévoir)
2. **Échange de cartes** (le lien social de la communauté)
3. **Combat** : volontairement repoussé en phase 2. Ne pas le construire sans demande explicite.

## Décisions prises

- Booster de 5 cartes : cartes 1 à 3 toujours communes ; carte 4 commune avec 1 chance sur 5 d'être peu commune
  et 1 sur 15 d'être rare ; carte 5 au moins peu commune, avec 1 chance sur 5 d'être rare et 1 sur 100 d'être légendaire.
- Carte secrète : 1 chance sur 1000 par booster, à la place de la carte 5, **non échangeable**.
- God Pack : 1 chance sur 2000 ; 1 peu commune, 3 rares, 1 légendaire.
- (21/09/2026) Légendaire et carte secrète jugées trop fréquentes en test ("on a tous légendaire et tout") :
  légendaire de carte 5 passée de 1/20 à 1/100, carte secrète de 1/100 à 1/1000, God Pack de 1/200 à 1/2000.
- Aucun système de « pitié » : aléatoire pur. Probabilités à essayer puis ajuster (tout est dans `src/config.ts`).
- Première série : environ 100 cartes (50 communes, 35 peu communes, 10 rares, 5 légendaires) + 1 secrète.
- Boosters rares, liés à la vie de la chaîne (lives, événements, codes distribués par le compte admin), pas de gain
  quotidien automatique. Les quantités seront réglées plus tard, à l'équilibrage. L'abonnement Twitch offre des
  boosters (quantité à définir).
- Échange **uniquement entre deux cartes de même rareté**, **asynchrone** (une demande reste en attente, pas
  d'échange en direct). Les collections sont visibles par tous. Un joueur envoie une demande à un autre en
  proposant une de ses cartes et en indiquant celle qu'il veut.
- Recyclage de doublons contre de la monnaie : mis de côté pour l'instant, on garde seulement l'échange.
- Monnaie interne : prévue pour des éléments de personnalisation (fonds de profil, titres, etc.). Sa source et
  ce que recouvre « cartes » dans les achats restent à définir.
- Compte admin : peut tout gérer : événements, codes de boosters (nombre d'usages, durée), problèmes de comptes,
  récupérations, bannissements et sanctions. Chaque action admin est journalisée.
- Twitch : connexion « Se connecter avec Twitch ». Le statut de **follower et d'abonné (sub)** à la chaîne est
  important. Ce que débloque le simple follow reste à définir.

## Technique

- Cloudflare : Worker (TypeScript, Hono) + base D1 (SQLite) + fichiers statiques dans `public/`. Gratuit pour la
  phase de test (100 000 requêtes/jour ; base : 5 millions de lignes lues, 100 000 écrites par jour). Pas de serveur à gérer.
- **Les règles du jeu sont portées par la base** (contraintes CHECK et déclencheurs dans `migrations/0001_init.sql`).
  Raison : D1 n'a pas de transactions classiques ; un lot (`batch`) est annulé en entier seulement si la base lève
  une erreur. Toute nouvelle règle qui protège l'intégrité des cartes doit pouvoir provoquer une erreur (`RAISE(ABORT, 'E_...')`)
  et être traduite dans `DB_TOKENS` de `src/db.ts`. Ne jamais faire de lecture puis d'écriture séparées pour une règle.
- Le tirage des boosters se fait toujours côté serveur, jamais dans le navigateur.
- Pas de temps réel en phase 1 (échanges asynchrones). Le combat en direct, plus tard, pourra utiliser les Durable Objects.
- Sessions : cookie signé (HMAC) contenant l'identifiant du joueur. La connexion Twitch devra produire le même cookie.
- `DEV_AUTH` (connexion de test sans Twitch) doit rester à `"0"` en production. Ne jamais commiter de secret
  (`.dev.vars` est ignoré par Git).
- (22/09/2026) Connexion de test : chaque pseudo a son propre mot de passe, choisi librement à la première
  connexion (premier arrivé, premier servi, comme un pseudo Discord). Il n'y a plus de mot de passe de site
  partagé (abandonné : ça compliquait la compréhension pour rien, et forçait de fait tout le monde à avoir
  le même mot de passe). Un joueur qui oublie le sien doit demander à un admin de le réinitialiser (onglet
  Administration → Gestion des comptes). L'admin peut aussi supprimer un compte (irréversible : collection,
  échanges et codes créés disparaissent avec).
- Twitch (vérifié le 21/09/2026 sur dev.twitch.tv ; l'API évolue, revalider avant de coder) :
  - **Abonnement (sub)** : scope `channel:read:subscriptions`, autorisé **une seule fois par le streamer**
    (pas par chaque joueur). Vérifier un joueur précis : `GET /subscriptions` avec son `user_id`.
  - **Follow** : ⚠️ correction d'une erreur de ce fichier — ce n'est plus `user:read:follows` (Twitch a supprimé
    cette permission en 2023 pour la vie privée). Le bon scope est `moderator:read:followers`, autorisé **une
    seule fois par le streamer ou un modérateur** (pas par le joueur non plus). Vérifier un joueur précis :
    `GET /channels/followers` avec son `user_id`. Donc follow et abonnement se vérifient tous les deux via une
    autorisation unique du streamer/modérateur : la connexion d'un joueur n'a besoin d'aucun scope particulier
    côté joueur, juste de son identité.
  - **Connexion d'un joueur** : OAuth Authorization Code vers `id.twitch.tv/oauth2/authorize`, puis échange du
    code contre un jeton sur `id.twitch.tv/oauth2/token` (`client_id`, `client_secret` côté serveur, `redirect_uri`
    identique aux deux étapes). Prévoir le jeton de rafraîchissement (`grant_type=refresh_token`).
  - **EventSub (notifications d'abonnement)** : webhooks HTTPS (port 443) ; signature HMAC-SHA256 calculée sur
    `Twitch-Eventsub-Message-Id` + `Twitch-Eventsub-Message-Timestamp` + le **corps brut** de la requête (ne pas
    re-sérialiser le JSON : ça change les octets et casse la signature) ; répondre au défi initial ; dédupliquer
    sur l'identifiant du message ; répondre en quelques secondes.
- Hébergement : Cloudflare avec le nom de domaine du propriétaire (le DNS peut être confié à Cloudflare).
  Mise en ligne prévue par GitHub + Workers Builds (déploiement à chaque `git push`, liens de test par branche).

## Commandes

```bash
npm install
cp .dev.vars.example .dev.vars   # première fois seulement (Windows : copy)
npm run db:local                 # base locale avec les 101 cartes
npm run dev                      # jeu sur http://localhost:8787 (connexion de test : pseudo « admin »)
npm test                         # tests (fausse base D1 sérialisée comme la vraie)
npm run typecheck
npm run smoke                    # parcours complet contre le serveur lancé par npm run dev
npm run simulate                 # nombre de boosters pour compléter la série (vrai code de tirage)
```

Après toute modification : `npm test` et `npm run typecheck`. Après une modification de l'API, de la base ou de
`public/index.html` : `npm run smoke` contre `npm run dev`. Une modification de schéma passe par un **nouveau**
fichier dans `migrations/` (jamais en éditant un fichier déjà appliqué).

## Façon de travailler avec le propriétaire

- Répondre en français, simplement. Le propriétaire dicte souvent ses messages : reformuler pour confirmer une
  décision de jeu ambiguë avant de la coder.
- Les décisions de jeu (probabilités, règles, économie) se discutent d'abord ; les noter ici une fois tranchées.
- Le design de l'interface attend le choix de l'univers : la page `public/index.html` reste volontairement sobre.

## Prochaines étapes

1. Mettre le projet sur GitHub et connecter Cloudflare (déploiement automatique, lien de test)
2. Connexion Twitch (statut follow et abonné), en remplacement de la connexion de test
3. Notifications d'abonnement (EventSub) qui créditent des boosters
4. Codes de boosters et événements créés par l'admin
5. Animation d'ouverture soignée, puis vrais noms et images des cartes (après le choix de l'univers)
6. Monnaie interne (après avoir défini comment on la gagne)
7. Combat (phase 2)

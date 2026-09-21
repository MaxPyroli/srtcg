-- Schéma initial du TCG communautaire.
--
-- Principe : les règles importantes sont portées par la base elle-même.
-- D1 exécute un lot d'instructions comme une seule transaction, mais ne l'annule
-- que si la base renvoie une erreur. Chaque règle du jeu doit donc pouvoir
-- provoquer une erreur (contrainte CHECK ou RAISE dans un déclencheur).
-- Les jetons E_XXXX des messages d'erreur sont traduits en réponses claires
-- par le code (voir src/db.ts).

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  twitch_id     TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  boosters      INTEGER NOT NULL DEFAULT 0 CHECK (boosters >= 0),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE cards (
  id        INTEGER PRIMARY KEY,
  slug      TEXT    NOT NULL UNIQUE,
  name      TEXT    NOT NULL,
  rarity    TEXT    NOT NULL CHECK (rarity IN ('commune', 'peu_commune', 'rare', 'legendaire', 'secrete')),
  tradable  INTEGER NOT NULL DEFAULT 1 CHECK (tradable IN (0, 1))
);

-- Une ligne par joueur et par carte possédée.
-- "reserved" = exemplaires bloqués par une demande d'échange en attente.
CREATE TABLE collection (
  user_id   INTEGER NOT NULL REFERENCES users (id),
  card_id   INTEGER NOT NULL REFERENCES cards (id),
  quantity  INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reserved  INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  PRIMARY KEY (user_id, card_id),
  CHECK (reserved <= quantity)
) WITHOUT ROWID;

CREATE TABLE openings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id),
  kind       TEXT    NOT NULL CHECK (kind IN ('normal', 'secret', 'god')),
  card_ids   TEXT    NOT NULL,
  opened_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX openings_user ON openings (user_id);

CREATE TABLE trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user       INTEGER NOT NULL REFERENCES users (id),
  to_user         INTEGER NOT NULL REFERENCES users (id),
  offered_card    INTEGER NOT NULL REFERENCES cards (id),
  requested_card  INTEGER NOT NULL REFERENCES cards (id),
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);
CREATE INDEX trades_from ON trades (from_user);
CREATE INDEX trades_to ON trades (to_user);

-- Une demande d'échange ne peut être conclue qu'une seule fois :
-- la clé primaire sur trade_id rend tout second essai impossible.
CREATE TABLE trade_resolutions (
  trade_id     INTEGER PRIMARY KEY REFERENCES trades (id),
  outcome      TEXT    NOT NULL CHECK (outcome IN ('accepted', 'declined', 'cancelled')),
  actor_id     INTEGER NOT NULL REFERENCES users (id),
  resolved_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE admin_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id     INTEGER NOT NULL REFERENCES users (id),
  action       TEXT    NOT NULL,
  target_user  INTEGER REFERENCES users (id),
  details      TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Garde-fous
-- ---------------------------------------------------------------------------

-- Le stock de boosters ne peut jamais devenir négatif.
CREATE TRIGGER users_boosters_guard
BEFORE UPDATE OF boosters ON users
WHEN NEW.boosters < 0
BEGIN
  SELECT RAISE(ABORT, 'E_NO_BOOSTER');
END;

-- Une demande d'échange doit respecter toutes les règles du jeu.
CREATE TRIGGER trades_validate
BEFORE INSERT ON trades
BEGIN
  SELECT RAISE(ABORT, 'E_SELF_TRADE')
    WHERE NEW.from_user = NEW.to_user;

  SELECT RAISE(ABORT, 'E_CARD_UNKNOWN')
    WHERE NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.offered_card)
       OR NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.requested_card);

  SELECT RAISE(ABORT, 'E_SAME_CARD')
    WHERE NEW.offered_card = NEW.requested_card;

  SELECT RAISE(ABORT, 'E_NOT_TRADABLE')
    WHERE EXISTS (SELECT 1 FROM cards WHERE id IN (NEW.offered_card, NEW.requested_card) AND tradable = 0);

  SELECT RAISE(ABORT, 'E_RARITY_MISMATCH')
    WHERE (SELECT rarity FROM cards WHERE id = NEW.offered_card)
       <> (SELECT rarity FROM cards WHERE id = NEW.requested_card);

  -- Le demandeur doit posséder un exemplaire non réservé de la carte offerte.
  SELECT RAISE(ABORT, 'E_NOT_OWNED')
    WHERE NOT EXISTS (
      SELECT 1 FROM collection
      WHERE user_id = NEW.from_user AND card_id = NEW.offered_card AND quantity - reserved >= 1
    );

  -- Le destinataire doit posséder la carte demandée.
  SELECT RAISE(ABORT, 'E_TARGET_NOT_OWNED')
    WHERE NOT EXISTS (
      SELECT 1 FROM collection
      WHERE user_id = NEW.to_user AND card_id = NEW.requested_card AND quantity >= 1
    );
END;

-- Conclure une demande : elle doit exister, être en attente, être conclue par la
-- bonne personne, et les deux joueurs doivent toujours avoir leurs cartes.
CREATE TRIGGER trade_resolutions_validate
BEFORE INSERT ON trade_resolutions
BEGIN
  SELECT RAISE(ABORT, 'E_TRADE_NOT_FOUND')
    WHERE NOT EXISTS (SELECT 1 FROM trades WHERE id = NEW.trade_id);

  SELECT RAISE(ABORT, 'E_TRADE_CLOSED')
    WHERE (SELECT status FROM trades WHERE id = NEW.trade_id) <> 'pending';

  SELECT RAISE(ABORT, 'E_FORBIDDEN')
    WHERE NEW.outcome IN ('accepted', 'declined')
      AND NEW.actor_id <> (SELECT to_user FROM trades WHERE id = NEW.trade_id);

  SELECT RAISE(ABORT, 'E_FORBIDDEN')
    WHERE NEW.outcome = 'cancelled'
      AND NEW.actor_id <> (SELECT from_user FROM trades WHERE id = NEW.trade_id);

  SELECT RAISE(ABORT, 'E_NOT_OWNED')
    WHERE NEW.outcome = 'accepted'
      AND NOT EXISTS (
        SELECT 1 FROM trades t
        JOIN collection c ON c.user_id = t.from_user AND c.card_id = t.offered_card
        WHERE t.id = NEW.trade_id AND c.quantity >= 1 AND c.reserved >= 1
      );

  SELECT RAISE(ABORT, 'E_TARGET_NOT_OWNED')
    WHERE NEW.outcome = 'accepted'
      AND NOT EXISTS (
        SELECT 1 FROM trades t
        JOIN collection c ON c.user_id = t.to_user AND c.card_id = t.requested_card
        WHERE t.id = NEW.trade_id AND c.quantity - c.reserved >= 1
      );
END;

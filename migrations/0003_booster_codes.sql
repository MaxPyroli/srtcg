-- Codes de boosters : créés par l'admin (nombre de boosters, nombre d'utilisations,
-- durée de validité optionnelle), réclamés une fois par joueur.

CREATE TABLE booster_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  boosters    INTEGER NOT NULL CHECK (boosters > 0),
  max_uses    INTEGER NOT NULL CHECK (max_uses > 0),
  uses        INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  expires_at  TEXT,
  created_by  INTEGER NOT NULL REFERENCES users (id),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Une réclamation par joueur et par code (empêche un même joueur de le réutiliser).
CREATE TABLE booster_code_redemptions (
  code_id      INTEGER NOT NULL REFERENCES booster_codes (id),
  user_id      INTEGER NOT NULL REFERENCES users (id),
  redeemed_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code_id, user_id)
) WITHOUT ROWID;

CREATE TRIGGER booster_code_redeem_validate
BEFORE INSERT ON booster_code_redemptions
BEGIN
  SELECT RAISE(ABORT, 'E_CODE_NOT_FOUND')
    WHERE NOT EXISTS (SELECT 1 FROM booster_codes WHERE id = NEW.code_id);

  SELECT RAISE(ABORT, 'E_CODE_EXPIRED')
    WHERE (SELECT expires_at FROM booster_codes WHERE id = NEW.code_id) IS NOT NULL
      AND (SELECT expires_at FROM booster_codes WHERE id = NEW.code_id) <= datetime('now');

  SELECT RAISE(ABORT, 'E_CODE_EXHAUSTED')
    WHERE (SELECT uses FROM booster_codes WHERE id = NEW.code_id)
       >= (SELECT max_uses FROM booster_codes WHERE id = NEW.code_id);

  SELECT RAISE(ABORT, 'E_CODE_ALREADY_USED')
    WHERE EXISTS (
      SELECT 1 FROM booster_code_redemptions WHERE code_id = NEW.code_id AND user_id = NEW.user_id
    );
END;

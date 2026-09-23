-- Sanctions (bannissement, prévu dans les décisions de jeu mais jamais construit) et monnaie interne
-- (source et usage encore à définir, mais on a besoin du compteur dès maintenant).
ALTER TABLE users ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0 CHECK (is_banned IN (0, 1));
ALTER TABLE users ADD COLUMN ban_reason TEXT;
ALTER TABLE users ADD COLUMN currency INTEGER NOT NULL DEFAULT 0 CHECK (currency >= 0);

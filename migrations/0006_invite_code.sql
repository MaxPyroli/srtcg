-- Réglages de l'application, gérés depuis l'admin (pas des secrets Cloudflare).
-- Sert d'abord au code d'invitation : requis pour créer un compte tant qu'il est défini,
-- inutile une fois qu'on ouvre le jeu à tout le monde (il suffit de l'effacer).

CREATE TABLE app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

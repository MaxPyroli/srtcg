-- Mot de passe individuel pour la connexion de test (au lieu d'un seul mot de passe partagé).
-- NULL pour les comptes créés avant cette migration : ils choisissent le leur à leur prochaine
-- connexion (voir devLogin dans src/db.ts).

ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;

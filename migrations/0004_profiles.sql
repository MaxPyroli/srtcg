-- Profils joueurs : icône (emoji + couleur), bio courte, carte vedette.
-- L'icône est choisie dans une liste fixe côté serveur (src/config.ts) : pas d'upload d'image.

ALTER TABLE users ADD COLUMN avatar_emoji TEXT NOT NULL DEFAULT '🙂';
ALTER TABLE users ADD COLUMN avatar_color TEXT NOT NULL DEFAULT '#2b59c3';
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 200);
ALTER TABLE users ADD COLUMN featured_card_id INTEGER REFERENCES cards (id);

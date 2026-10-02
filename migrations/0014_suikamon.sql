-- Classement de Suikamon (mini-jeu à part, sans compte). Chaque joueur est une clé aléatoire gardée dans son
-- navigateur ; le serveur lui attribue un pseudo aléatoire. On ne garde que le meilleur score de chacun.
CREATE TABLE suikamon_scores (
  player_id  TEXT    PRIMARY KEY CHECK (length(player_id) = 32),
  pseudo     TEXT    NOT NULL,
  score      INTEGER NOT NULL CHECK (score >= 0),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX suikamon_scores_rank ON suikamon_scores (score DESC, updated_at);

-- Parties démarrées dont le score a déjà été envoyé : un jeton de partie ne sert qu'une fois.
CREATE TABLE suikamon_runs (
  nonce   TEXT PRIMARY KEY,
  used_at TEXT NOT NULL DEFAULT (datetime('now'))
);

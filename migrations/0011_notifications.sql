-- Petits messages pour informer un joueur d'un événement survenu hors ligne (ex. boosters offerts
-- par un admin) : pas de temps réel en phase 1, donc on les affiche à la prochaine visite.
CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users (id),
  message     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  read_at     TEXT
);
CREATE INDEX notifications_unread ON notifications (user_id, read_at);

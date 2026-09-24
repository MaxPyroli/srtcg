-- Une demande d'échange sans réponse expire après un délai (TRADE_EXPIRY_HOURS dans src/config.ts).
-- Vérifiée à chaque lecture des échanges (expirePendingTrades dans src/db.ts), pas de tâche
-- planifiée : pas de temps réel en phase 1.
-- "expired" est un simple indicateur, pas un nouveau statut : le statut réutilise "cancelled"
-- (même libération de la carte réservée), ça évite de reconstruire trades pour changer sa
-- contrainte CHECK. L'indicateur sert juste à afficher "Expirée" plutôt que "Annulée".
ALTER TABLE trades ADD COLUMN expired INTEGER NOT NULL DEFAULT 0 CHECK (expired IN (0, 1));

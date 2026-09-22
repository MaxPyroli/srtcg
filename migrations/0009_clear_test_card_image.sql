-- Le visuel de test (migration 0008) a servi à valider l'intégration : on le retire, la carte
-- repasse en placeholder "New art coming soon" comme les autres, en attendant les vraies illustrations.
UPDATE cards SET image = NULL WHERE slug = 'rare-01';

-- Test local uniquement : on branche le visuel de test sur une carte rare, pour valider l'intégration
-- avant de refaire ça en vrai avec les illustrations définitives. À retirer/adapter plus tard.
UPDATE cards SET image = '/img/cards/rare-01.png' WHERE slug = 'rare-01';

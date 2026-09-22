-- Test d'un vrai visuel par carte (en local pour l'instant) : chemin d'une image statique, optionnel.
-- Tant que ce champ est vide, le site continue d'afficher le placeholder "New art coming soon".
ALTER TABLE cards ADD COLUMN image TEXT;

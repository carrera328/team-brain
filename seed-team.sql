-- Seed team members for The Catalyst Crew
-- Run: npx wrangler d1 execute team-brain-db --remote --file=seed-team.sql

INSERT OR REPLACE INTO users (email, name, role, team_role, created_at, updated_at) VALUES
  ('carrera.328@gmail.com', 'Sal Carrera', 'admin', 'developer', datetime('now'), datetime('now')),
  ('gmarkay@outlook.com', 'Griffin Markay', 'member', 'developer', datetime('now'), datetime('now')),
  ('venkivenki8697@gmail.com', 'Venkata Gorrepati', 'member', 'developer', datetime('now'), datetime('now')),
  ('rekha.g@outlook.com', 'Rekha Gorrepati', 'member', 'qa', datetime('now'), datetime('now')),
  ('ptgolas@hotmail.com', 'Perry Golas', 'member', 'product_owner', datetime('now'), datetime('now'));

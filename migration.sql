-- Team Brain — D1 Database Schema
-- Run: npx wrangler d1 execute team-brain-db --remote --file=migration.sql

-- Shared brain entries (notes, ideas, decisions, action items, etc.)
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'note',
  author TEXT,
  tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Team members
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'member',
  team_role TEXT DEFAULT 'developer',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- OAuth tables (for MCP server authentication)
CREATE TABLE IF NOT EXISTS oauth_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT UNIQUE NOT NULL,
  client_secret TEXT,
  client_id_issued_at INTEGER,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  client_name TEXT,
  token_endpoint_auth_method TEXT DEFAULT 'none',
  grant_types TEXT DEFAULT '["authorization_code"]',
  response_types TEXT DEFAULT '["code"]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  scope TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  scope TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  state TEXT,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

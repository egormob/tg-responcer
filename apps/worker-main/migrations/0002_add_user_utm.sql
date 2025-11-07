-- Migration number: 0002
-- Migration name: add_user_utm
-- Created at: 2025-10-24

PRAGMA foreign_keys = ON;

ALTER TABLE users
  ADD COLUMN utm_source TEXT;

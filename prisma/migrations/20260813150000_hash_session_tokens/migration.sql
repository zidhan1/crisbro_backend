-- Session.token historically contained the bearer JWT itself. Hash every
-- existing value in place so a database read cannot be used to impersonate a
-- live user. Application code hashes future tokens before lookup/storage.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE "Session"
SET "token" = encode(digest("token", 'sha256'), 'hex')
WHERE "token" !~ '^[0-9a-f]{64}$';

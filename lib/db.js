// ── Postgres (DATABASE_URL, e.g. Neon) ──────────────────────────────────────
// Versioned migrations run on start; every query is parameterized.

var pool = null;
var readyPromise = null;

var MIGRATIONS = [
  // 1: accounts, social, clans, reviews, moderation
  [
    "CREATE TABLE IF NOT EXISTS users (" +
    "  id BIGSERIAL PRIMARY KEY," +
    "  public_id TEXT UNIQUE NOT NULL," +
    "  email TEXT UNIQUE NOT NULL," +
    "  password_hash TEXT," +
    "  google_sub TEXT UNIQUE," +
    "  name TEXT NOT NULL," +
    "  avatar TEXT NOT NULL DEFAULT 'fox'," +
    "  role TEXT NOT NULL DEFAULT 'user'," +
    "  data JSONB NOT NULL DEFAULT '{}'," +
    "  data_updated_at TIMESTAMPTZ," +
    "  watching JSONB," +
    "  public_profile BOOLEAN NOT NULL DEFAULT TRUE," +
    "  xp INTEGER NOT NULL DEFAULT 0," +
    "  banned_at TIMESTAMPTZ," +
    "  ban_reason TEXT," +
    "  last_login_at TIMESTAMPTZ," +
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    "CREATE TABLE IF NOT EXISTS sessions (" +
    "  token_hash TEXT PRIMARY KEY," +
    "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
    "  user_agent TEXT," +
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "  expires_at TIMESTAMPTZ NOT NULL)",
    "CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)",
    "CREATE TABLE IF NOT EXISTS friends (" +
    "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
    "  friend_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "  PRIMARY KEY (user_id, friend_id))",
    // Episodes watched to the end: XP, achievements and the friends feed.
    "CREATE TABLE IF NOT EXISTS watches (" +
    "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
    "  anime_id TEXT NOT NULL," +
    "  ep INTEGER NOT NULL," +
    "  title TEXT NOT NULL," +
    "  cover TEXT," +
    "  watched_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "  PRIMARY KEY (user_id, anime_id, ep))",
    "CREATE TABLE IF NOT EXISTS activities (" +
    "  id BIGSERIAL PRIMARY KEY," +
    "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
    "  type TEXT NOT NULL," +
    "  anime_id TEXT," +
    "  title TEXT," +
    "  cover TEXT," +
    "  ep INTEGER," +
    "  extra JSONB," +
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    "CREATE INDEX IF NOT EXISTS activities_user ON activities(user_id, created_at DESC)",
    "CREATE TABLE IF NOT EXISTS reviews (" +
    "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
    "  anime_id TEXT NOT NULL," +
    "  ep INTEGER NOT NULL," +
    "  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5)," +
    "  text TEXT NOT NULL DEFAULT ''," +
    "  hidden BOOLEAN NOT NULL DEFAULT FALSE," +
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "  PRIMARY KEY (user_id, anime_id, ep))",
    "CREATE INDEX IF NOT EXISTS reviews_episode ON reviews(anime_id, ep)",
    "CREATE TABLE IF NOT EXISTS clans (" +
    "  id BIGSERIAL PRIMARY KEY," +
    "  public_id TEXT UNIQUE NOT NULL," +
    "  name TEXT NOT NULL," +
    "  description TEXT NOT NULL DEFAULT ''," +
    "  emoji TEXT NOT NULL DEFAULT '⚔️'," +
    "  color TEXT NOT NULL DEFAULT 'orange'," +
    "  owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL," +
    "  hidden BOOLEAN NOT NULL DEFAULT FALSE," +
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    "CREATE UNIQUE INDEX IF NOT EXISTS clans_name ON clans(lower(name))",
    "CREATE TABLE IF NOT EXISTS clan_members (" +
    "  clan_id BIGINT NOT NULL REFERENCES clans(id) ON DELETE CASCADE," +
    "  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE," +
    "  role TEXT NOT NULL DEFAULT 'member'," +
    "  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "  PRIMARY KEY (clan_id, user_id))",
    "CREATE TABLE IF NOT EXISTS posts (" +
    "  id BIGSERIAL PRIMARY KEY," +
    "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
    "  clan_id BIGINT REFERENCES clans(id) ON DELETE CASCADE," +
    "  text TEXT NOT NULL," +
    "  anime_id TEXT," +
    "  anime_title TEXT," +
    "  hidden BOOLEAN NOT NULL DEFAULT FALSE," +
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    "CREATE INDEX IF NOT EXISTS posts_recent ON posts(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS posts_clan ON posts(clan_id, created_at DESC)",
    "CREATE TABLE IF NOT EXISTS post_likes (" +
    "  post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE," +
    "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
    "  PRIMARY KEY (post_id, user_id))",
    "CREATE TABLE IF NOT EXISTS comments (" +
    "  id BIGSERIAL PRIMARY KEY," +
    "  post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE," +
    "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
    "  text TEXT NOT NULL," +
    "  hidden BOOLEAN NOT NULL DEFAULT FALSE," +
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    "CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id, created_at)",
    "CREATE TABLE IF NOT EXISTS reports (" +
    "  id BIGSERIAL PRIMARY KEY," +
    "  reporter_id BIGINT REFERENCES users(id) ON DELETE SET NULL," +
    "  target_type TEXT NOT NULL," +
    "  target_id TEXT NOT NULL," +
    "  reason TEXT NOT NULL," +
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "  resolved_at TIMESTAMPTZ," +
    "  resolved_by BIGINT REFERENCES users(id) ON DELETE SET NULL," +
    "  UNIQUE (reporter_id, target_type, target_id))",
    "CREATE TABLE IF NOT EXISTS audit_log (" +
    "  id BIGSERIAL PRIMARY KEY," +
    "  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL," +
    "  action TEXT NOT NULL," +
    "  target TEXT," +
    "  ip TEXT," +
    "  meta JSONB," +
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    "CREATE INDEX IF NOT EXISTS audit_recent ON audit_log(created_at DESC)"
  ],
  // 2: spoiler flags, public lists, weekly clan challenges
  [
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS spoiler BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS spoiler BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE reviews ADD COLUMN IF NOT EXISTS spoiler BOOLEAN NOT NULL DEFAULT FALSE",
    "CREATE TABLE IF NOT EXISTS user_lists (" +
    "  id BIGSERIAL PRIMARY KEY," +
    "  public_id TEXT UNIQUE NOT NULL," +
    "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
    "  title TEXT NOT NULL," +
    "  description TEXT NOT NULL DEFAULT ''," +
    "  items JSONB NOT NULL DEFAULT '[]'," +
    "  hidden BOOLEAN NOT NULL DEFAULT FALSE," +
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "  updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    "CREATE INDEX IF NOT EXISTS user_lists_owner ON user_lists(user_id, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS watches_recent ON watches(watched_at)"
  ]
];

function init() {
  if (!process.env.DATABASE_URL) return;
  var pg = require('pg');
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 10000
  });
  pool.on('error', function(err) { console.error('[DB] idle client error:', err.message); });
  readyPromise = migrate().then(function(v) { console.log('[DB] ready, schema v' + v); }, function(err) {
    console.error('[DB] migration failed:', err.message);
    throw err;
  });
  readyPromise.catch(function() {});
  // Housekeeping promised in the privacy policy: expired sessions go away, and
  // security logs are kept for at most 12 months.
  setInterval(function() {
    readyPromise.then(function() {
      return Promise.all([
        pool.query('DELETE FROM sessions WHERE expires_at < now()'),
        pool.query("DELETE FROM audit_log WHERE created_at < now() - interval '365 days'"),
        pool.query("DELETE FROM activities WHERE created_at < now() - interval '365 days'")
      ]);
    }).catch(function(e) { console.error('[DB] cleanup:', e.message); });
  }, 6 * 60 * 60 * 1000).unref();
}

async function migrate() {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  var r = await pool.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
  var current = +r.rows[0].v;
  for (var i = current; i < MIGRATIONS.length; i++) {
    var client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (var sql of MIGRATIONS[i]) await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [i + 1]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(function() {});
      throw e;
    } finally {
      client.release();
    }
  }
  return MIGRATIONS.length;
}

function enabled() { return !!pool; }
function ready() { return readyPromise || Promise.reject(new Error('database disabled')); }
function query(sql, params) { return pool.query(sql, params); }

async function tx(fn) {
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    var out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(function() {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { init: init, enabled: enabled, ready: ready, query: query, tx: tx };

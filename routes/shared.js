// Shapes of users/clans as other people see them. E-mails never leave the server
// except to the account owner and admins.
var xp = require('../lib/xp');

var AVATARS = ['fox', 'cat', 'dragon', 'ninja', 'samurai', 'robot', 'ghost', 'panda', 'tiger', 'owl', 'frog', 'alien', 'sakura', 'star', 'moon', 'fire'];
var CLAN_EMOJIS = ['⚔️', '🐉', '🌙', '🍃', '🔥', '⚡', '🌸', '👑', '🦊', '🐺', '💀', '🌊', '🎯', '🛡️', '🗡️', '🌟'];
var CLAN_COLORS = ['orange', 'red', 'blue', 'purple', 'green', 'pink', 'teal', 'gold'];

function card(u) {
  if (!u) return null;
  var info = xp.levelInfo(u.xp || 0);
  return { publicId: u.public_id, name: u.name, avatar: u.avatar, level: info.level, levelTitle: info.title };
}

function me(u) {
  return {
    publicId: u.public_id, name: u.name, email: u.email, avatar: u.avatar, role: u.role,
    publicProfile: u.public_profile, hasPassword: !!u.password_hash, google: !!u.google_sub, createdAt: u.created_at
  };
}

function clanCard(c) {
  if (!c) return null;
  return { publicId: c.public_id, name: c.name, emoji: c.emoji, color: c.color, description: c.description,
    members: c.members == null ? undefined : +c.members, xp: c.xp == null ? undefined : +c.xp };
}

var WATCHING_FRESH_MS = 15 * 60 * 1000;
function freshWatching(u) {
  var w = u.watching;
  return w && w.at && Date.now() - w.at < WATCHING_FRESH_MS ? w : null;
}

module.exports = { AVATARS: AVATARS, CLAN_EMOJIS: CLAN_EMOJIS, CLAN_COLORS: CLAN_COLORS, card: card, me: me, clanCard: clanCard, freshWatching: freshWatching };

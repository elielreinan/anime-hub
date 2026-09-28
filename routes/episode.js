// /api/episode/:slug/:ep?title=&lang= - player embeds for one episode.
// Servers that viewers keep reporting as broken go to the end of the list.
var sendJSON = require('../lib/http').sendJSON;
var dooplay = require('../sources/dooplay');
var health = require('./health');

function handleEpisode(req, res, pathname, urlObj) {
  var parts = pathname.split('/').filter(Boolean);
  var slug = decodeURIComponent(parts[2] || '');
  var episode = parts[3] || '1';
  var title = (urlObj.searchParams.get('title') || slug.replace(/-/g, ' ')).slice(0, 200);

  dooplay.findEpisodeEmbeds(title, episode, urlObj.searchParams.get('lang') || '').then(function(result) {
    console.log('[Episode] "' + title + '" ep ' + episode + ': ' + result.embeds.length + ' players', JSON.stringify(result.trace));
    if (!result.embeds.length) {
      sendJSON(res, 404, { error: true, message: 'Episódio não encontrado', trace: result.trace });
      return;
    }
    var embeds = result.embeds.map(function(e, i) {
      var host = health.hostOf(e.url);
      return { kind: e.kind, url: e.url, label: e.label, provider: e.provider, referer: e.referer, proxy: e.proxy, host: host, unstable: health.isUnstable(host), order: i };
    });
    // The host that has been playing this show for other viewers goes first.
    var best = health.bestHost(title);
    embeds.forEach(function(e) { e.best = !!best && e.host === best.host && !e.unstable; });
    embeds.sort(function(a, b) { return (a.unstable - b.unstable) || (b.best - a.best) || (a.order - b.order); });
    sendJSON(res, 200, { error: false, data: { type: 'embed', provider: embeds[0].provider, embed_url: embeds[0].url, embeds: embeds }, trace: result.trace });
  }).catch(function(err) {
    console.error('[Episode] Error:', err.message);
    sendJSON(res, 500, { error: true, message: 'Erro ao buscar o episódio' });
  });
}

module.exports = { handleEpisode: handleEpisode };

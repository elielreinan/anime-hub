var n = require('../lib/net');
var fetchUrl = n.fetchUrl;
var sendJSON = require('../lib/http').sendJSON;

var ATV_BASE = 'https://atv2.net/meuanimetv-74.php?';

var BLOCKED_GENRES = [
  'hentai', 'ecchi', 'erotica', 'yaoi', 'yuri', 'nudity',
  'sexual', 'adult', 'r-18', 'r18', 'pornô', 'xxx', 'sukebe'
];

// ── AnimeTV API Module ──────────────────────────────────────────────────────

// Content filter: checks if an item contains blocked adult content
function isBlockedContent(item) {
  if (!item || typeof item !== 'object') return false;

  var fieldsToCheck = [
    item.category_name || '',
    item.category_genres || '',
    item.category_description || ''
  ];

  var combined = fieldsToCheck.join(' ').toLowerCase();

  for (var i = 0; i < BLOCKED_GENRES.length; i++) {
    if (combined.indexOf(BLOCKED_GENRES[i]) !== -1) {
      var name = item.category_name || item.title || 'Unknown';
      console.log('[ContentFilter] Blocked: ' + name + ' (reason: ' + BLOCKED_GENRES[i] + ')');
      return true;
    }
  }
  return false;
}

// Filter an array of items, removing adult content
function filterContentArray(items) {
  if (!Array.isArray(items)) return items;
  return items.filter(function(item) {
    return !isBlockedContent(item);
  });
}

// Filter ATV API response (handles both arrays and single objects)
function filterATVResponse(body) {
  try {
    var data = JSON.parse(body.toString());
    if (Array.isArray(data)) {
      return JSON.stringify(filterContentArray(data));
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Single object response (info endpoint)
      if (isBlockedContent(data)) {
        return JSON.stringify({ error: true, message: 'Content blocked by filter' });
      }
      // Check nested arrays (e.g., episodes list within info)
      var keys = Object.keys(data);
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(data[keys[i]])) {
          data[keys[i]] = filterContentArray(data[keys[i]]);
        }
      }
      return JSON.stringify(data);
    }
    return body.toString();
  } catch (e) {
    // Not valid JSON, return as-is
    return body.toString();
  }
}

// Handle /api/atv/* - proxy for AnimeTV API with content filtering
function handleATVProxy(pathname, urlObj, res) {
  var atvPath = pathname.replace('/api/atv/', '');
  var atvQuery = urlObj.search || '';
  var atvUrl = ATV_BASE + atvPath + atvQuery.replace('?', '&');

  console.log('[ATV-Proxy] Fetching:', atvUrl);

  fetchUrl(atvUrl).then(function(result) {
    var filtered = filterATVResponse(result.body);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(filtered);
  }).catch(function(err) {
    console.error('[ATV-Proxy] Error:', err.message);
    sendJSON(res, 502, { error: true, message: err.message });
  });
}

module.exports = { handleATVProxy: handleATVProxy };

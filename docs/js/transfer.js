// ── Moving data to another device ──
// Everything lives in this browser; the transfer link carries it in the URL
// fragment, which browsers never send to any server.
var TRANSFER_KEYS = ['lists', 'settings', 'skipmarks'];

function collectUserData() {
  var data = { v: 1, history: getWatchHistory(), follow: notifyState.items };
  TRANSFER_KEYS.forEach(function(k) { data[k] = getStore(k); });
  return data;
}

function bytesToB64url(bytes) {
  var bin = '';
  for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
  var bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function streamBytes(bytes, transform) {
  return new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer().then(function(b) { return new Uint8Array(b); });
}

function encodeUserData(data) {
  var bytes = new TextEncoder().encode(JSON.stringify(data));
  if (!window.CompressionStream) return Promise.resolve('j' + bytesToB64url(bytes));
  return streamBytes(bytes, new CompressionStream('deflate-raw')).then(function(z) { return 'z' + bytesToB64url(z); });
}

function decodeUserData(code) {
  var bytes = b64urlToBytes(code.slice(1));
  var p = code[0] === 'z' ? streamBytes(bytes, new DecompressionStream('deflate-raw')) : Promise.resolve(bytes);
  return p.then(function(b) { return JSON.parse(new TextDecoder().decode(b)); });
}

function mergeUserData(data) {
  if (!data || data.v !== 1) throw new Error('bad data');
  var lists = getUserLists();
  Object.keys(data.lists || {}).forEach(function(name) {
    var mine = lists[name] || [];
    (data.lists[name] || []).forEach(function(a) { if (!mine.some(function(x) { return x.id == a.id; })) mine.push(a); });
    lists[name] = mine;
  });
  setUserLists(lists);
  var byId = {};
  getWatchHistory().concat(data.history || []).forEach(function(h) {
    if (!byId[h.id] || (h.updatedAt || 0) > (byId[h.id].updatedAt || 0)) byId[h.id] = h;
  });
  setWatchHistory(Object.keys(byId).map(function(k) { return byId[k]; }).sort(function(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).slice(0, 20));
  var marks = getStore('skipmarks');
  Object.keys(data.skipmarks || {}).forEach(function(k) { if (!marks[k]) marks[k] = data.skipmarks[k]; });
  setStore('skipmarks', marks);
  var settings = getStore('settings');
  Object.keys(data.settings || {}).forEach(function(k) { if (!(k in settings)) settings[k] = data.settings[k]; });
  setStore('settings', settings);
  Object.keys(data.follow || {}).forEach(function(k) { if (!notifyState.items[k]) notifyState.items[k] = data.follow[k]; });
  return writeNotifyState().then(function() {
    renderProfileStats();
    renderProfileName();
    renderContinueWatching();
  });
}

function openTransfer() { openSheet('transfer-sheet'); }

function shareTransferLink() {
  encodeUserData(collectUserData()).then(function(code) {
    var link = location.origin + location.pathname + '#import=' + code;
    var text = 'Meus dados do AnimeHub: abra este link no outro aparelho';
    if (navigator.share) { navigator.share({ title: 'AnimeHub', text: text, url: link }).catch(function() {}); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(function() { showToast('Link copiado: abra no outro aparelho'); }, function() { prompt('Copie o link:', link); });
    else prompt('Copie o link:', link);
  }).catch(function() { showToast('Não foi possível gerar o link'); });
}

function downloadBackup() {
  var blob = new Blob([JSON.stringify(collectUserData())], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'animehub-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function restoreBackupFile(input) {
  var file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  file.text().then(function(t) { return mergeUserData(JSON.parse(t)); })
    .then(function() { showToast('Backup restaurado'); closeSheet('transfer-sheet'); })
    .catch(function() { showToast('Arquivo de backup inválido'); });
}

function importFromHash() {
  var m = location.hash.match(/^#import=([jz][A-Za-z0-9_-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (!confirm('Trazer as listas, o histórico e os animes seguidos do outro aparelho para este? Nada daqui será apagado.')) return;
  decodeUserData(m[1]).then(mergeUserData)
    .then(function() { showToast('Dados importados!'); })
    .catch(function() { showToast('Link de transferência inválido ou incompleto'); });
}

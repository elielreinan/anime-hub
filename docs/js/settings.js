// ── Settings ──
var DEFAULT_SETTINGS = { lang: 'sub', autoplay: true, resume: true, skipSeconds: 85, autoSkip: true, notifications: false, nickname: '', speed: 1, captionSize: 'm', captionBg: true };

function getSettings() {
  var saved = getStore('settings'), out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function(k) { out[k] = (k in saved) ? saved[k] : DEFAULT_SETTINGS[k]; });
  return out;
}

function setSetting(key, value) {
  var s = getStore('settings');
  s[key] = value;
  setStore('settings', s);
  if (key === 'nickname') renderProfileName();
}


function getDefaultNickname() { return 'Visitante'; }

function renderProfileName() {
  document.getElementById('profile-name').textContent = displayName();
}

function displayName() {
  return (account && account.user.name) || getSettings().nickname || getDefaultNickname();
}

function openSheet(id) { document.getElementById(id).classList.add('show'); }
function closeSheet(id) { document.getElementById(id).classList.remove('show'); }

function openSettings() { renderSettings(); openSheet('settings-sheet'); }

function settingRow(label, desc, control) {
  return '<div class="setting-row"><div><div class="setting-label">' + label + '</div>' +
    (desc ? '<div class="setting-desc">' + desc + '</div>' : '') + '</div>' + control + '</div>';
}

function settingToggle(key, on) {
  return '<label class="switch"><input type="checkbox"' + (on ? ' checked' : '') + ' onchange="onSettingToggle(\'' + key + '\', this.checked)"><span></span></label>';
}

function onSettingToggle(key, on) {
  if (key === 'captionBg') { setSetting('captionBg', on); applyCaptionStyle(); return; }
  setSetting(key, on);
  if (key === 'notifications' && on) {
    requestNotificationPermission().then(function(granted) {
      if (!granted) { setSetting('notifications', false); renderSettings(); return; }
      registerPeriodicCheck();
      showToast('Notificações ativadas');
    });
  }
}

// Text tracks (::cue) only; burned-in subtitles can't be restyled.
function applyCaptionStyle() {
  var s = getSettings();
  var size = { s: '80%', m: '100%', l: '130%', xl: '160%' }[s.captionSize] || '100%';
  var el = document.getElementById('caption-style');
  if (!el) { el = document.createElement('style'); el.id = 'caption-style'; document.head.appendChild(el); }
  el.textContent = 'video::cue { font-size: ' + size + '; ' + (s.captionBg ? 'background: rgba(0,0,0,0.75);' : 'background: transparent; text-shadow: 0 0 4px #000, 0 0 2px #000;') + ' }';
}

function renderSettings() {
  var s = getSettings();
  var perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  var notifDesc = perm === 'denied' ? 'Bloqueadas no navegador: libere nas permissões do site'
    : perm === 'unsupported' ? 'Seu navegador não suporta notificações'
    : 'Avisa quando sair episódio novo dos animes que você segue';
  var langBtns = [['sub', 'Legendado'], ['dub', 'Dublado']].map(function(o) {
    return '<button class="' + (s.lang === o[0] ? 'active' : '') + '" onclick="setSetting(\'lang\',\'' + o[0] + '\');renderSettings()">' + o[1] + '</button>';
  }).join('');
  var skipOpts = [60, 85, 90, 120].map(function(v) {
    return '<option value="' + v + '"' + (s.skipSeconds === v ? ' selected' : '') + '>' + v + 's</option>';
  }).join('');
  document.getElementById('settings-body').innerHTML =
    '<div class="setting-group">Reprodução</div>' +
    settingRow('Áudio preferido', 'Usado quando o anime não diz se é dublado ou legendado', '<div class="segmented">' + langBtns + '</div>') +
    settingRow('Próximo episódio automático', 'Começa o próximo 5s depois que o episódio acaba', settingToggle('autoplay', s.autoplay)) +
    settingRow('Continuar de onde parei', 'Volta ao ponto em que você parou o episódio', settingToggle('resume', s.resume)) +
    settingRow('Pular abertura', 'Quanto o botão "Pular abertura" avança', '<select class="sort-select" onchange="setSetting(\'skipSeconds\', +this.value)">' + skipOpts + '</select>') +
    settingRow('Tamanho da legenda', 'Para servidores com legenda separada (a maioria já vem com a legenda gravada no vídeo)', '<div class="segmented">' + [['s', 'P'], ['m', 'M'], ['l', 'G'], ['xl', 'GG']].map(function(o) {
      return '<button class="' + (s.captionSize === o[0] ? 'active' : '') + '" onclick="setSetting(\'captionSize\',\'' + o[0] + '\');applyCaptionStyle();renderSettings()">' + o[1] + '</button>';
    }).join('') + '</div>') +
    settingRow('Fundo escuro na legenda', 'Deixa a legenda mais fácil de ler', settingToggle('captionBg', s.captionBg)) +
    settingRow('Pular abertura sozinho', 'Depois que você pula a abertura em 2 episódios do mesmo anime, as próximas são puladas automaticamente', settingToggle('autoSkip', s.autoSkip)) +
    '<div class="setting-group">Notificações</div>' +
    settingRow('Novos episódios', notifDesc, settingToggle('notifications', s.notifications && perm === 'granted')) +
    '<div class="setting-group">Assistir junto</div>' +
    settingRow('Seu nome na sala', 'Aparece para quem assiste com você', '<input class="setting-input" maxlength="30" value="' + escapeHtml(s.nickname || getDefaultNickname()) + '" onchange="setSetting(\'nickname\', this.value.trim())">') +
    (account ? '<div class="setting-group">Conta</div>' +
      settingRow('Perfil público', 'Quem tiver seu ID ou link vê suas listas e o que você está assistindo', '<label class="switch"><input type="checkbox"' + (account.user.publicProfile ? ' checked' : '') + ' onchange="updateAccount({ publicProfile: this.checked })"><span></span></label>') +
      settingRow('Senha', account.user.hasPassword ? 'Trocar a senha desconecta os outros aparelhos' : 'Sua conta entra com o Google; crie uma senha se quiser', '<button class="setting-danger" style="color:#fff;border-color:#2d2d3d" onclick="changePassword()">' + (account.user.hasPassword ? 'Trocar' : 'Criar') + '</button>') +
      settingRow('Meus dados', 'Baixe tudo que guardamos sobre você (LGPD)', '<button class="setting-danger" style="color:#fff;border-color:#2d2d3d" onclick="exportAccount()">Baixar</button>') +
      settingRow('Sair de todos os aparelhos', 'Use se perdeu um celular ou entrou em um aparelho de outra pessoa', '<button class="setting-danger" onclick="logoutEverywhere()">Sair</button>') +
      settingRow('Sair da conta', escapeHtml(account.user.email), '<button class="setting-danger" onclick="logout()">Sair</button>') +
      settingRow('Excluir conta', 'Apaga sua conta e os dados salvos nela', '<button class="setting-danger" onclick="deleteAccount()">Excluir</button>') : '') +
    '<div class="setting-group">Dados</div>' +
    settingRow('Histórico', 'Apaga "Continuar Assistindo" e o progresso dos episódios', '<button class="setting-danger" onclick="clearHistory()">Limpar</button>') +
    settingRow('Cache do app', 'Baixa de novo o app e as imagens', '<button class="setting-danger" onclick="clearAppCache()">Limpar</button>') +
    '<div style="height:90px"></div>';
}

function clearHistory() {
  if (!confirm('Apagar todo o histórico de episódios?')) return;
  setWatchHistory([]);
  renderContinueWatching();
  showToast('Histórico apagado');
}

function clearAppCache() {
  if (!('caches' in window)) { location.reload(); return; }
  caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k) { return k !== STATE_CACHE; }).map(function(k) { return caches.delete(k); }));
  }).then(function() { location.reload(); });
}

// ── Cookies ──
// Shown every time the site or app is opened (once per visit).
function showBetaNotice() { document.getElementById('beta-notice').classList.add('show'); }
function closeBetaNotice() {
  document.getElementById('beta-notice').classList.remove('show');
  try { sessionStorage.setItem('ah_beta_seen', '1'); } catch (e) {}
}
(function initBetaNotice() {
  var seen = false;
  try { seen = !!sessionStorage.getItem('ah_beta_seen'); } catch (e) {}
  if (!seen) showBetaNotice();
})();

function initCookieBanner() {
  var ok = false;
  try { ok = !!localStorage.getItem('ah_cookie_ok'); } catch (e) {}
  if (!ok) document.getElementById('cookie-banner').classList.add('show');
}

function acceptCookies() {
  try { localStorage.setItem('ah_cookie_ok', String(Date.now())); } catch (e) {}
  document.getElementById('cookie-banner').classList.remove('show');
}

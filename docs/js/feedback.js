// ── Feedback: bugs, ideas, anything else. Works signed in or not. ──
var feedbackKind = 'bug';

function openFeedback() {
  feedbackKind = 'bug';
  openGenericSheet('Enviar feedback', '<div class="transfer-box">' +
    '<div class="party-muted">Encontrou um erro ou tem uma ideia? A gente lê tudo.</div>' +
    '<div class="rank-tabs" id="fb-kinds">' + [['bug', 'Problema'], ['idea', 'Sugestão'], ['other', 'Outro']].map(function(k, i) {
      return '<button type="button" class="filter-chip' + (i ? '' : ' active') + '" onclick="setFeedbackKind(this,\'' + k[0] + '\')">' + k[1] + '</button>';
    }).join('') + '</div>' +
    '<textarea class="auth-field" id="fb-text" maxlength="2000" rows="5" placeholder="Conte o que aconteceu ou o que você gostaria de ver"></textarea>' +
    '<input class="auth-field" id="fb-contact" maxlength="120" placeholder="Contato para resposta (opcional)">' +
    '<div class="auth-error" id="fb-error" role="alert"></div>' +
    '<button class="party-btn" id="fb-send" onclick="sendFeedback()">Enviar</button></div>');
  if (account && account.user && account.user.email) document.getElementById('fb-contact').placeholder = 'Responderemos em ' + account.user.email;
}

function setFeedbackKind(el, kind) {
  feedbackKind = kind;
  el.parentElement.querySelectorAll('.filter-chip').forEach(function(c) { c.classList.toggle('active', c === el); });
}

function sendFeedback() {
  var btn = document.getElementById('fb-send'), err = document.getElementById('fb-error');
  var text = document.getElementById('fb-text').value.trim();
  if (text.length < 5) { err.textContent = 'Conte um pouco mais.'; return; }
  var client = (window.Capacitor ? 'app' : 'web') + ' · ' + window.innerWidth + 'x' + window.innerHeight + ' · ' + (document.documentElement.getAttribute('data-theme') || 'dark');
  btn.disabled = true;
  err.textContent = '';
  accountApi('/api/feedback', 'POST', { kind: feedbackKind, text: text, contact: document.getElementById('fb-contact').value, client: client }).then(function() {
    closeGenericSheet();
    showToast('Obrigado! Feedback enviado.');
  }).catch(function(e) {
    err.textContent = e.code === 'accounts_off' ? 'O envio de feedback ainda não foi ativado no servidor.' : e.message === 'Failed to fetch' ? 'Sem conexão com o servidor' : e.message;
    btn.disabled = false;
  });
}

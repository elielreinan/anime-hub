// ── Episode ratings and comments ──
// Opened from the ★ button in the player (current episode).

var reviewTarget = null, reviewRating = 0;

function openReviews() {
  if (!currentAnime || !playerEpisode) return;
  reviewTarget = { animeId: safeId(currentAnime.id), ep: playerEpisode, title: getTitle(currentAnime) };
  openGenericSheet('Ep ' + playerEpisode + ' · ' + reviewTarget.title, '<div class="empty-state">Carregando...</div>');
  loadReviews();
}

function starsHtml(n, size) {
  var out = '';
  for (var i = 1; i <= 5; i++) out += '<span class="star' + (i <= n ? ' on' : '') + '" style="font-size:' + (size || 14) + 'px">★</span>';
  return out;
}

function loadReviews() {
  var t = reviewTarget;
  accountApi('/api/reviews/' + t.animeId + '/' + t.ep).then(function(r) {
    reviewRating = r.mine ? r.mine.rating : 0;
    var max = Math.max.apply(null, r.dist.concat([1]));
    var html = '<div class="review-summary"><div class="review-avg">' + (r.count ? r.avg.toFixed(1) : '–') + '</div><div>' + starsHtml(Math.round(r.avg), 18) +
      '<div class="party-muted">' + r.count + (r.count === 1 ? ' avaliação' : ' avaliações') + '</div></div><div class="review-dist">' +
      [5, 4, 3, 2, 1].map(function(n) { return '<div><span>' + n + '</span><i style="width:' + Math.round((r.dist[n - 1] / max) * 100) + '%"></i></div>'; }).join('') + '</div></div>';
    if (account) {
      html += '<div class="transfer-box"><div class="party-muted">' + (r.mine ? 'Sua avaliação' : 'O que você achou deste episódio?') + '</div>' +
        '<div class="star-input" id="star-input">' + [1, 2, 3, 4, 5].map(function(n) { return '<button type="button" onclick="setReviewRating(' + n + ')" aria-label="' + n + ' estrelas">★</button>'; }).join('') + '</div>' +
        '<textarea class="auth-field" id="review-text" maxlength="500" rows="2" placeholder="Comentário (opcional)"></textarea>' +
        '<label class="spoiler-check"><input type="checkbox" id="review-spoiler"' + (r.mine && r.mine.spoiler ? ' checked' : '') + '> Contém spoiler</label>' +
        '<div class="party-row"><button class="party-btn" style="flex:1" onclick="saveReview()">' + (r.mine ? 'Atualizar' : 'Avaliar') + '</button>' +
        (r.mine ? '<button class="party-btn ghost" onclick="deleteReview()">Remover</button>' : '') + '</div></div>';
    } else {
      html += '<div class="transfer-box"><button class="party-btn" onclick="openAuth(\'login\')">Entre para avaliar</button></div>';
    }
    html += '<div class="section-header"><h2 class="section-title">Comentários</h2></div><div id="review-list"></div>';
    document.getElementById('generic-body').innerHTML = html;
    if (r.mine) document.getElementById('review-text').value = r.mine.text || '';
    paintStars();
    var list = document.getElementById('review-list');
    if (!r.items.length) { list.innerHTML = '<div class="empty-state">Ninguém comentou ainda.</div>'; return; }
    r.items.forEach(function(it) {
      var row = document.createElement('div');
      row.className = 'comment';
      row.innerHTML = userLine(it.author, (it.friend ? 'amigo · ' : '') + timeAgo(it.at)) + '<div>' + starsHtml(it.rating) + '</div><div class="comment-text' + (it.spoiler ? ' spoiler' : '') + '"' + (it.spoiler ? ' onclick="revealSpoiler(this)"' : '') + '></div>' +
        (it.mine ? '' : '<div class="comment-actions"><button onclick="reportContent(\'review\',\'' + reviewTarget.animeId + ':' + reviewTarget.ep + ':' + safeId(it.author.publicId) + '\')">Denunciar</button></div>');
      row.querySelector('.comment-text').textContent = it.text;
      list.appendChild(row);
    });
  }).catch(function(e) {
    document.getElementById('generic-body').innerHTML = '<div class="empty-state">' + escapeHtml(e.code === 'accounts_off' ? 'Avaliações ainda não foram ativadas no servidor.' : e.message) + '</div>';
  });
}

function setReviewRating(n) { reviewRating = n; paintStars(); }
function paintStars() {
  var el = document.getElementById('star-input');
  if (el) el.querySelectorAll('button').forEach(function(b, i) { b.classList.toggle('on', i < reviewRating); });
}

function saveReview() {
  if (!reviewRating) { showToast('Escolha de 1 a 5 estrelas'); return; }
  var t = reviewTarget;
  accountApi('/api/reviews/' + t.animeId + '/' + t.ep, 'PUT', { rating: reviewRating, text: document.getElementById('review-text').value, spoiler: document.getElementById('review-spoiler').checked, title: t.title }).then(function(r) {
    showToast('Avaliação salva!');
    if (r.level) renderLevel(r.level);
    loadReviews();
  }).catch(function(e) { showToast(e.message); });
}

function deleteReview() {
  var t = reviewTarget;
  accountApi('/api/reviews/' + t.animeId + '/' + t.ep, 'DELETE').then(function() { showToast('Avaliação removida'); loadReviews(); }).catch(function(e) { showToast(e.message); });
}

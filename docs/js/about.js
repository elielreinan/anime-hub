// ── Sobre: what AnimeHub is (and isn't) ──
function openAbout() {
  openGenericSheet('Sobre o AnimeHub', '<div class="about">' +
    '<div class="about-logo"><span class="logo-accent">ANIME</span>HUB</div>' +
    '<p>O AnimeHub é um app gratuito para descobrir e assistir animes, feito para ser simples, rápido e bom de usar no celular.</p>' +
    '<h3>Não hospedamos nenhum anime</h3>' +
    '<p>Nenhum vídeo fica nos nossos servidores. O AnimeHub funciona como um <b>roteador</b>: organiza catálogo, episódios e agenda e direciona o player para fontes públicas que já existem na internet. ' +
    'Nós não enviamos, armazenamos nem controlamos esse conteúdo.</p>' +
    '<p>Se você é dono de algum conteúdo e quer que ele deixe de aparecer aqui, fale com a gente pelo <a href="#" onclick="closeGenericSheet(); openFeedback(); return false;">feedback</a> que removemos o acesso.</p>' +
    '<h3>O que é nosso</h3>' +
    '<p>A interface, as listas, o histórico, a sala Juntos, a comunidade, os clãs e as avaliações. Os dados de agenda e personagens vêm do MyAnimeList (via Jikan).</p>' +
    '<h3>Quem fez</h3>' +
    '<p>Desenvolvido por <b>Eliel</b>. O app está em fase de testes, então algumas coisas podem falhar — conte pra gente o que achar.</p>' +
    '<div class="about-links"><a href="termos.html">Termos</a> · <a href="privacidade.html">Privacidade</a> · <a href="status.html">Status dos servidores</a></div>' +
    '</div>');
}

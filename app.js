/* CONFIGURAÇÃO: cole somente a URL pública e a chave anon/publicável do projeto.
   NUNCA coloque service_role, secret key ou senha de banco neste arquivo. */
const SUPABASE_URL = 'COLE_SUA_SUPABASE_URL_AQUI';
const SUPABASE_ANON_KEY = 'COLE_SUA_SUPABASE_ANON_KEY_AQUI';

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const STATES = ['Pendente', 'Em andamento', 'Concluído'];
  const COLUMNS = ['pending', 'progress', 'done'];
  const WEIGHT = { 'Baixa': 1, 'Média': 2, 'Alta/Urgente': 3 };
  let db, manager = null, rows = [], knownIds = null;
  let channel = null, poll = null, refreshing = false, queued = false, epoch = 0;
  let realtimeOnline = false, soundEnabled = false, audio = null;
  let submission = null;
  const updating = new Set();

  function message(id, text = '', type = '') {
    const box = $(id);
    box.textContent = text;
    box.className = `message ${type}`;
    box.hidden = !text;
  }
  function connection() {
    $('connection-state').textContent = realtimeOnline
      ? '● Tempo real conectado · conferência a cada 15 s'
      : 'Atualização automática a cada 15 segundos';
  }
  function route() {
    const management = location.hash === '#gestao';
    $('employee-view').hidden = management;
    $('management-view').hidden = !management;
    $('nav-enviar').setAttribute('aria-current', management ? 'false' : 'page');
    $('nav-gestao').setAttribute('aria-current', management ? 'page' : 'false');
  }
  window.addEventListener('hashchange', route);
  route();

  // Preferências locais: nenhum dado de demanda ou senha é salvo aqui.
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('theme-toggle').textContent = theme === 'dark' ? 'Tema claro' : 'Tema escuro';
    try { localStorage.setItem('central-theme', theme); } catch { /* Opcional. */ }
  }
  let theme = 'light';
  try { theme = localStorage.getItem('central-theme') || theme; } catch { /* Opcional. */ }
  setTheme(theme === 'dark' ? 'dark' : 'light');
  $('theme-toggle').addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  $('description').addEventListener('input', () => {
    $('char-count').textContent = `${$('description').value.length}/4000`;
  });

  const configured = /^https:\/\//.test(SUPABASE_URL)
    && !SUPABASE_URL.includes('COLE_') && !SUPABASE_ANON_KEY.includes('COLE_');
  if (!configured || !window.supabase) {
    $('config-notice').hidden = false;
    $('config-notice').textContent = !configured
      ? 'Configure SUPABASE_URL e SUPABASE_ANON_KEY no início de app.js para conectar o formulário e o monitor.'
      : 'A biblioteca do Supabase não carregou. Confira a conexão com a internet e recarregue.';
    $('send-button').disabled = true;
    $('login-button').disabled = true;
    return;
  }
  // As políticas RLS do SQL protegem os dados mesmo com a chave pública no navegador.
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  $('request-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const fields = new FormData(form);
    const payload = {
      solicitante: String(fields.get('solicitante')).trim(),
      departamento: String(fields.get('departamento')),
      prioridade: String(fields.get('prioridade')),
      descricao: String(fields.get('descricao')).trim()
    };
    if (payload.solicitante.length < 2 || payload.descricao.length < 10) {
      message('submit-message', 'Preencha seu nome e uma descrição com pelo menos 10 caracteres.', 'error');
      return;
    }
    // Reutiliza o UUID em nova tentativa do mesmo envio, evitando duplicações
    // se a conexão cair depois de o banco já ter gravado o pedido.
    const signature = JSON.stringify(payload);
    if (!submission || submission.signature !== signature) {
      submission = { signature, id: crypto.randomUUID() };
    }
    const button = $('send-button');
    button.disabled = true;
    button.textContent = 'Enviando…';
    message('submit-message');
    try {
      // Não use .select() aqui: funcionários podem enviar, mas não ler pedidos.
      const { error } = await db.from('demandas').insert({ id: submission.id, ...payload });
      if (error && error.code !== '23505') throw error;
      message('submit-message', `Demanda enviada! Protocolo: ${submission.id.slice(0, 8).toUpperCase()}. A gestão receberá no monitor.`, 'success');
      submission = null;
      form.reset();
      $('char-count').textContent = '0/4000';
    } catch {
      message('submit-message', 'Não foi possível confirmar o envio. Confira a conexão e tente novamente. Os campos foram mantidos.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Enviar demanda';
    }
  });

  function lockMonitor() {
    epoch++;
    manager = null;
    rows = [];
    knownIds = null;
    clearInterval(poll);
    poll = null;
    if (channel) db.removeChannel(channel).catch(() => {});
    channel = null;
    realtimeOnline = false;
    $('monitor-panel').hidden = true;
    $('login-panel').hidden = false;
    document.body.classList.remove('fullscreen-view');
    COLUMNS.forEach(key => { $('cards-' + key).replaceChildren(); });
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  async function enterMonitor(session) {
    if (!session) { lockMonitor(); return false; }
    const currentEpoch = ++epoch;
    const { data, error } = await db.from('gestores')
      .select('user_id').eq('user_id', session.user.id).maybeSingle();
    if (currentEpoch !== epoch) return false;
    if (error || !data) {
      lockMonitor();
      message('login-message', 'Esta conta não foi autorizada como gestor. Confira a tabela gestores no Supabase.', 'error');
      return false;
    }
    clearInterval(poll);
    if (channel) await db.removeChannel(channel);
    if (currentEpoch !== epoch) return false;
    manager = session.user;
    knownIds = null; // Não toca alerta para os registros que já existiam.
    $('login-panel').hidden = true;
    $('monitor-panel').hidden = false;
    message('login-message');
    connection();
    await refresh(false);
    if (currentEpoch !== epoch) return false;
    channel = db.channel('monitor-demandas-' + session.user.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'demandas' }, () => refresh(true))
      .subscribe(status => {
        if (currentEpoch !== epoch) return;
        realtimeOnline = status === 'SUBSCRIBED';
        connection();
      });
    poll = setInterval(() => refresh(true), 15000);
    return true;
  }

  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('login-button').disabled = true;
    message('login-message');
    try {
      // A senha é validada no Supabase Auth, nunca comparada com uma senha no JS.
      const { data, error } = await db.auth.signInWithPassword({
        email: $('email').value.trim(), password: $('password').value
      });
      if (error) throw error;
      await enterMonitor(data.session);
    } catch {
      message('login-message', 'Não foi possível entrar. Confira o e-mail, a senha e a conexão.', 'error');
    } finally {
      $('password').value = '';
      $('login-button').disabled = false;
    }
  });
  $('logout-button').addEventListener('click', async () => {
    $('logout-button').disabled = true;
    try {
      const { error } = await db.auth.signOut({ scope: 'local' });
      if (error) throw error;
      lockMonitor();
    } catch {
      message('monitor-message', 'Não foi possível encerrar a sessão. Tente novamente.', 'error');
    } finally { $('logout-button').disabled = false; }
  });
  // Não execute consultas assíncronas dentro do callback de autenticação.
  db.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') setTimeout(lockMonitor, 0);
    if (event === 'TOKEN_REFRESHED' && session) {
      setTimeout(() => db.realtime.setAuth(session.access_token).catch(() => {}), 0);
    }
  });
  db.auth.getSession().then(({ data, error }) => {
    if (!error && data.session) enterMonitor(data.session).catch(() => {
      lockMonitor();
      message('login-message', 'Não foi possível restaurar o acesso. Entre novamente.', 'error');
    });
  }).catch(() => message('login-message', 'Não foi possível conectar. Tente entrar novamente.', 'error'));

  async function refresh(announce = true) {
    if (!manager) return;
    if (refreshing) { queued = true; return; }
    refreshing = true;
    const currentEpoch = epoch;
    $('refresh-button').disabled = true;
    try {
      // Pagina para não truncar o quadro no limite padrão de 1.000 registros.
      const result = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await db.from('demandas').select('*')
          .order('created_at', { ascending: false }).order('id', { ascending: true })
          .range(offset, offset + 999);
        if (error) throw error;
        if (currentEpoch !== epoch) return;
        result.push(...data);
        if (data.length < 1000) break;
      }
      if (currentEpoch !== epoch) return;
      const unique = [...new Map(result.map(row => [row.id, row])).values()];
      const arrivals = knownIds ? unique.filter(row => !knownIds.has(row.id)).length : 0;
      knownIds = new Set(unique.map(row => row.id));
      rows = unique;
      render();
      connection();
      $('last-sync').textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Fortaleza' });
      if (arrivals && announce) {
        message('monitor-message', `${arrivals} nova${arrivals === 1 ? ' demanda recebida' : 's demandas recebidas'}.`, 'success');
        playSound();
      } else if ($('monitor-message').classList.contains('error')) message('monitor-message');
    } catch {
      if (currentEpoch === epoch) {
        $('connection-state').textContent = 'Conexão indisponível · nova tentativa em 15 s';
        message('monitor-message', 'Não foi possível atualizar. Os últimos dados continuam visíveis; confira o horário da última atualização.', 'error');
      }
    } finally {
      refreshing = false;
      $('refresh-button').disabled = false;
      if (queued) { queued = false; if (manager) setTimeout(() => refresh(true), 0); }
    }
  }

  function render() {
    STATES.forEach((status, i) => {
      $('count-' + COLUMNS[i]).textContent = rows.filter(row => row.status === status).length;
    });
    $('count-urgent').textContent = rows.filter(row => row.prioridade === 'Alta/Urgente' && row.status !== 'Concluído').length;
    const department = $('filter-department').value;
    const priority = $('filter-priority').value;
    const query = $('filter-query').value.trim().toLocaleLowerCase('pt-BR');
    const filtered = rows.filter(row => (!department || row.departamento === department)
      && (!priority || row.prioridade === priority)
      && `${row.solicitante} ${row.descricao}`.toLocaleLowerCase('pt-BR').includes(query))
      .sort((a, b) => WEIGHT[b.prioridade] - WEIGHT[a.prioridade]
        || Date.parse(a.created_at) - Date.parse(b.created_at));
    STATES.forEach((status, i) => {
      const list = filtered.filter(row => row.status === status);
      const container = $('cards-' + COLUMNS[i]);
      container.replaceChildren();
      $('visible-' + COLUMNS[i]).textContent = list.length;
      if (!list.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-column';
        empty.textContent = 'Nenhuma demanda nesta coluna.';
        container.append(empty);
      } else list.forEach(row => container.append(card(row)));
    });
  }

  function element(tag, text, className = '') {
    const node = document.createElement(tag);
    node.textContent = text; // Não interpreta HTML enviado no formulário.
    node.className = className;
    return node;
  }
  function card(row) {
    const article = element('article', '', 'card' + (row.prioridade === 'Alta/Urgente' ? ' urgent' : ''));
    const top = element('div', '', 'card-top');
    top.append(element('span', row.prioridade, 'badge ' + (row.prioridade === 'Alta/Urgente' ? 'high' : row.prioridade === 'Média' ? 'medium' : '')));
    const time = element('time', new Date(row.created_at).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza'
    }));
    time.dateTime = row.created_at;
    top.append(time);
    article.append(top, element('h3', row.solicitante), element('p', row.departamento, 'department'),
      element('p', row.descricao, 'description'), element('small', 'Protocolo ' + row.id.slice(0, 8).toUpperCase(), 'short-id'));
    const actions = element('div', '', 'status-buttons');
    STATES.forEach(status => {
      const button = element('button', status, status === row.status ? 'current' : '');
      button.type = 'button';
      button.disabled = status === row.status || updating.has(row.id);
      button.setAttribute('aria-label', `Marcar demanda de ${row.solicitante} como ${status}`);
      button.addEventListener('click', () => changeStatus(row, status));
      actions.append(button);
    });
    article.append(actions);
    return article;
  }
  async function changeStatus(row, status) {
    if (!manager || updating.has(row.id)) return;
    updating.add(row.id);
    render();
    try {
      const { data, error } = await db.from('demandas').update({ status })
        .eq('id', row.id).eq('updated_at', row.updated_at).select('id');
      if (error) throw error;
      if (!data.length) {
        message('monitor-message', 'Este pedido foi alterado por outro gestor. O quadro foi atualizado; confira antes de tentar novamente.', 'error');
      } else message('monitor-message', 'Situação atualizada.', 'success');
      await refresh(true);
    } catch {
      message('monitor-message', 'Não foi possível mudar a situação. Confira a conexão e tente novamente.', 'error');
    } finally { updating.delete(row.id); render(); }
  }
  ['filter-department', 'filter-priority'].forEach(id => $(id).addEventListener('change', render));
  $('filter-query').addEventListener('input', render);
  $('refresh-button').addEventListener('click', () => refresh(true));

  // Navegadores exigem um clique para liberar reprodução sonora.
  $('sound-toggle').addEventListener('click', async () => {
    if (soundEnabled) {
      soundEnabled = false;
    } else {
      try {
        const Audio = window.AudioContext || window.webkitAudioContext;
        audio ||= new Audio();
        await audio.resume();
        if (audio.state !== 'running') throw new Error('Áudio indisponível');
        soundEnabled = true;
      } catch {
        message('monitor-message', 'O navegador não liberou o áudio. Verifique as permissões de som e tente novamente.', 'error');
      }
    }
    $('sound-toggle').textContent = soundEnabled ? 'Som ativado' : 'Ativar som';
    $('sound-toggle').setAttribute('aria-pressed', String(soundEnabled));
  });
  function playSound() {
    if (!soundEnabled || !audio || audio.state !== 'running') return;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.07, audio.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.28);
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.start(); oscillator.stop(audio.currentTime + 0.3);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
  $('fullscreen-toggle').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      document.body.classList.toggle('fullscreen-view');
      $('fullscreen-toggle').textContent = document.body.classList.contains('fullscreen-view') ? 'Sair da tela cheia' : 'Tela cheia';
      message('monitor-message', 'O navegador não liberou a tela cheia. Use F11 no computador para ampliar.', '');
    }
  });
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('fullscreen-view', Boolean(document.fullscreenElement));
    $('fullscreen-toggle').textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
  });
})();

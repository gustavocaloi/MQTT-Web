import { validFilter, topicMatches } from './topic-filter.js';
import { initializeConnectionDialog } from './connection-dialog.js';

const $ = id => document.getElementById(id);
const collator = new Intl.Collator('pt-BR', { numeric: true });
const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
const root = { children: new Map(), key: 'root', count: 0 };
const state = {
  topics: new Map(), expanded: new Set(), flat: [], rows: new Map(), structureDirty: true,
  query: '', generation: 0, paused: false, socket: null, selected: null, page: 1,
  pageSize: 100, pageData: null, message: null, previous: null, follow: true,
  anchor: null, request: null, requestToken: 0, needsPage: false, lastFetch: 0,
  totalMessages: 0, topicCount: 0, view: 'diff', worker: null, diffToken: 0,
};
window.lucide.createIcons();
const icons = new Map();
function icon(name) {
  if (!icons.has(name)) icons.set(name, window.lucide.createElement(window.lucide.icons[name]));
  return icons.get(name).cloneNode(true);
}
function button(name, title, action) {
  const el = document.createElement('button');
  el.className = 'icon-button';
  el.title = title;
  el.setAttribute('aria-label', title);
  el.append(icon(name));
  el.onclick = action;
  return el;
}
function notice(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}
function time(value) { return value ? clock.format(new Date(value)) : '-'; }
function bytes(value) { return value < 1024 ? value + ' B' : (value / 1024).toFixed(1) + ' KB'; }

function upsert(topic, flash) {
  const old = state.topics.get(topic.topic);
  if (old && old.count >= topic.count) return;
  state.topics.set(topic.topic, topic);
  if (!old) state.structureDirty = true;
  const parts = topic.topic.split('/');
  let node = root;
  for (let depth = 0; depth < parts.length; depth++) {
    const part = parts[depth];
    if (!node.children.has(part)) {
      node.children.set(part, { children: new Map(), key: JSON.stringify(parts.slice(0, depth + 1)), path: parts.slice(0, depth + 1).join('/'), label: part || '(vazio)', count: 0, flashUntil: 0 });
      state.structureDirty = true;
    }
    node = node.children.get(part);
    node.count += topic.count - (old?.count || 0);
    if (flash) node.flashUntil = performance.now() + 1000;
  }
  node.topic = topic.topic;
  if (state.selected === topic.topic && state.follow) state.needsPage = true;
}

function snapshot(data) {
  const cleared = data.generation !== state.generation;
  root.children.clear();
  $('treeRows').replaceChildren();
  state.rows.clear();
  state.topics.clear();
  state.generation = data.generation;
  state.pageSize = Math.min(200, data.limits.messagesPerPage || 100);
  state.totalMessages = data.totalMessages;
  state.topicCount = data.topicCount;
  for (const topic of data.topics) upsert(topic, false);
  state.structureDirty = true;
  if (cleared || (state.selected !== null && !state.topics.has(state.selected))) resetDetail();
  else if (state.selected !== null && state.follow) state.needsPage = true;
  showStatus(data.mqtt);
  $('brokerUrl').textContent = data.mqtt.url || 'Sem conexao configurada';
  $('brokerUrl').title = data.mqtt.url;
  $('topicFilter').textContent = data.mqtt.topic;
  tick();
}
function showStatus(mqtt) {
  const online = !!mqtt?.connected && !state.paused;
  $('connectionStatus').textContent = state.paused ? 'Pausado' : online ? 'Conectado' : 'Desconectado';
  $('connectionStatus').classList.toggle('online', online);
  $('connectionStatus').title = mqtt?.lastError || '';
}
function connect() {
  if (state.paused) return;
  const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  state.socket = socket;
  socket.onmessage = event => {
    if (state.paused || state.socket !== socket) return;
    const { type, data } = JSON.parse(event.data);
    if (type === 'snapshot' || type === 'cleared') snapshot(data);
    if (type === 'status') showStatus(data);
    if (type === 'batch' && data.generation === state.generation) {
      for (const topic of data.topics) upsert(topic, true);
      state.totalMessages = data.totalMessages;
      state.topicCount = data.topicCount;
    }
  };
  socket.onclose = () => {
    if (state.socket !== socket) return;
    showStatus(null);
    if (!state.paused) setTimeout(connect, 1500);
  };
}

function flatten() {
  const visible = state.query ? new Set() : null;
  if (visible && validFilter(state.query)) {
    for (const topic of state.topics.keys()) {
      if (!topicMatches(state.query, topic)) continue;
      const parts = topic.split('/');
      for (let i = 1; i <= parts.length; i++) visible.add(JSON.stringify(parts.slice(0, i)));
    }
  }
  const rows = [];
  function visit(parent, depth) {
    const nodes = [...parent.children.values()].sort((a, b) => collator.compare(a.label, b.label) || a.path.localeCompare(b.path));
    for (const node of nodes) {
      if (visible && !visible.has(node.key)) continue;
      rows.push({ key: node.key, node, depth });
      if (!state.expanded.has(node.key)) continue;
      visit(node, depth + 1);
    }
  }
  visit(root, 0);
  state.flat = rows;
  state.structureDirty = false;
  $('treeSpacer').style.height = rows.length * 36 + 'px';
  $('treeCount').textContent = rows.length + ' caminhos';
}

function renderTree() {
  const viewport = $('treeViewport');
  const start = Math.max(0, Math.floor(viewport.scrollTop / 36) - 5);
  const end = Math.min(state.flat.length, start + Math.ceil(viewport.clientHeight / 36) + 12);
  const needed = new Set();
  for (let i = start; i < end; i++) {
    const item = state.flat[i];
    needed.add(item.key);
    let row = state.rows.get(item.key);
    if (!row) {
      row = document.createElement('div');
      row.className = 'tree-row';
      row.dataset.key = item.key;
      const toggle = document.createElement('button');
      toggle.className = 'tree-toggle';
      const label = document.createElement('span');
      label.className = 'tree-label';
      const count = document.createElement('span');
      count.className = 'tree-count';
      toggle.append(label);
      row.append(toggle, count, button('Filter', 'Filtrar ' + item.node.path, () => setFilter(item.node.path + '/#')));
      row.lastChild.classList.add('filter-button');
      toggle.onclick = () => {
        if (item.node.children.size) {
          state.expanded.has(item.node.key) ? state.expanded.delete(item.node.key) : state.expanded.add(item.node.key);
          state.structureDirty = true;
        }
        if (item.node.topic !== undefined && (!state.query || topicMatches(state.query, item.node.topic)) && state.selected !== item.node.topic) selectTopic(item.node.topic);
        else tick();
      };
      state.rows.set(item.key, row);
      $('treeRows').append(row);
    }
    row.style.position = 'absolute';
    row.style.top = i * 36 + 'px';
    row.style.width = '100%';
    row.style.paddingLeft = (12 + Math.min(item.depth, 10) * 14) + 'px';
    row.querySelector('.tree-label').textContent = item.node.label;
    row.querySelector('.tree-count').textContent = item.node.count.toLocaleString('pt-BR');
    row.querySelector('.tree-toggle').title = item.node.path;
    const toggle = row.querySelector('.tree-toggle');
    const hasChildren = item.node.children.size > 0;
    const hasMessages = item.node.topic !== undefined && (!state.query || topicMatches(state.query, item.node.topic));
    const iconName = hasChildren ? 'ChevronRight' : 'Braces';
    if (toggle.dataset.icon !== iconName) {
      toggle.querySelector('svg')?.remove();
      toggle.prepend(icon(iconName));
      toggle.dataset.icon = iconName;
    }
    if (hasChildren) {
      toggle.setAttribute('aria-expanded', String(state.expanded.has(item.node.key)));
      toggle.querySelector('svg').style.transform = state.expanded.has(item.node.key) ? 'rotate(90deg)' : '';
    } else toggle.removeAttribute('aria-expanded');
    if (hasMessages) toggle.setAttribute('aria-pressed', String(state.selected === item.node.topic));
    else toggle.removeAttribute('aria-pressed');
    row.classList.toggle('selected', hasMessages && state.selected === item.node.topic);
    row.classList.toggle('active', item.node.flashUntil > performance.now());
  }
  for (const [key, row] of state.rows) if (!needed.has(key)) { row.remove(); state.rows.delete(key); }
}
function setFilter(value) {
  state.query = value;
  $('searchInput').value = value;
  $('filterError').hidden = !value || validFilter(value);
  state.structureDirty = true;
  $('treeViewport').scrollTop = 0;
  tick();
}

function resetDetail() {
  state.request?.abort();
  state.request = null;
  state.requestToken++;
  state.diffToken++;
  state.selected = null;
  state.message = null;
  state.previous = null;
  state.pageData = null;
  state.needsPage = false;
  $('detail').hidden = true;
  $('emptyInspector').hidden = false;
  $('historyRows').replaceChildren();
  $('content').replaceChildren();
}
function selectTopic(topic) {
  resetDetail();
  state.selected = topic;
  state.follow = true;
  state.anchor = null;
  state.page = 1;
  $('selectedTopic').textContent = topic;
  $('detail').hidden = false;
  $('emptyInspector').hidden = true;
  $('messageMeta').textContent = 'Carregando...';
  $('liveButton').setAttribute('aria-pressed', 'true');
  state.needsPage = true;
  state.lastFetch = 0;
  tick();
}
async function loadPage() {
  if (state.request || state.selected === null || state.paused) return;
  const controller = new AbortController();
  state.request = controller;
  const token = ++state.requestToken;
  const generation = state.generation;
  state.needsPage = false;
  state.lastFetch = performance.now();
  const params = new URLSearchParams({ topic: state.selected, page: state.page, pageSize: state.pageSize });
  if (state.anchor !== null) params.set('before', state.anchor);
  try {
    const response = await fetch('/api/messages?' + params, { signal: controller.signal });
    if (!response.ok) throw new Error('Nao foi possivel carregar o historico.');
    const data = await response.json();
    if (token !== state.requestToken || generation !== state.generation || data.generation !== generation) return;
    state.pageData = data;
    state.page = data.page;
    if (state.follow || !state.message) chooseMessage(0, false);
    renderHistory();
    notice('');
  } catch (error) {
    if (error.name !== 'AbortError' && token === state.requestToken) {
      notice(error.message);
      state.needsPage = true;
      state.lastFetch = performance.now() + 1500;
    }
  } finally {
    if (state.request === controller) state.request = null;
  }
}
function chooseMessage(index, freeze = true) {
  if (freeze) {
    state.follow = false;
    state.anchor ??= state.pageData?.messages[0]?.sequence ?? null;
    state.needsPage = false;
    state.request?.abort();
    state.request = null;
    state.requestToken++;
  }
  const message = state.pageData?.messages[index] || null;
  const previous = state.pageData?.messages[index + 1] || state.pageData?.previous || null;
  const changed = state.message?.id !== message?.id || state.previous?.id !== previous?.id;
  state.message = message;
  state.previous = previous;
  $('liveButton').setAttribute('aria-pressed', String(state.follow));
  if (changed) renderMessage();
  renderHistory();
}
function renderHistory() {
  const data = state.pageData;
  if (!data) return;
  const signature = data.messages.map(m => m.id).join(',') + state.message?.id;
  if ($('historyRows').dataset.signature !== signature) {
    $('historyRows').dataset.signature = signature;
    $('historyRows').replaceChildren(...data.messages.map((message, index) => {
      const row = document.createElement('tr');
      row.classList.toggle('selected', state.message?.id === message.id);
      const cell = document.createElement('td');
      const select = document.createElement('button');
      select.textContent = time(message.receivedAt);
      select.title = 'Selecionar mensagem ' + message.receivedAt;
      select.onclick = () => chooseMessage(index);
      cell.append(select);
      row.append(cell);
      for (const value of [message.payloadFormat.toUpperCase(), bytes(message.payloadSize), message.qos, message.retained ? 'Sim' : '-']) {
        const td = document.createElement('td'); td.textContent = value; row.append(td);
      }
      return row;
    }));
  }
  $('historyCount').textContent = '(' + data.totalMessages + ')';
  $('pageLabel').textContent = data.page + ' / ' + data.totalPages;
  $('previousPage').disabled = data.page <= 1;
  $('nextPage').disabled = data.page >= data.totalPages;
}
function changePage(delta) {
  state.follow = false;
  state.anchor ??= state.pageData?.messages[0]?.sequence ?? null;
  state.page += delta;
  state.message = null;
  state.request?.abort(); state.request = null; state.requestToken++;
  state.needsPage = true;
  state.lastFetch = 0;
  $('liveButton').setAttribute('aria-pressed', 'false');
  tick();
}
function renderMessage() {
  const message = state.message;
  if (!message) { $('content').textContent = 'Nenhuma mensagem armazenada'; return; }
  $('messageMeta').textContent = time(message.receivedAt) + '  ·  ' + message.payloadFormat.toUpperCase() + '  ·  ' + bytes(message.payloadSize) + '  ·  QoS ' + message.qos + (message.retained ? '  ·  Retida' : '') + (message.truncated ? '  ·  Payload truncado' : '');
  $('comparisonMeta').textContent = state.view === 'payload' ? 'Mensagem selecionada' : state.previous ? time(state.previous.receivedAt) + '  →  ' + time(message.receivedAt) : 'Sem mensagem anterior armazenada';
  $('diffTab').setAttribute('aria-selected', String(state.view === 'diff'));
  $('payloadTab').setAttribute('aria-selected', String(state.view === 'payload'));
  $('diffStats').textContent = '';
  $('content').setAttribute('aria-busy', 'true');
  state.worker.postMessage({ token: ++state.diffToken, view: state.view, message, previous: state.previous });
}
function startWorker() {
  state.worker = new Worker('/diff-worker.js', { type: 'module' });
  state.worker.onmessage = ({ data }) => {
    if (data.token !== state.diffToken) return;
    $('content').removeAttribute('aria-busy');
    $('diffStats').textContent = data.stats;
    const nodes = data.lines.map(line => {
      const row = document.createElement('div'); row.className = 'code-line ' + line.kind;
      for (const [className, value] of [['line-number', line.old || ''], ['line-number', line.current || ''], ['line-sign', line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '], ['line-text', line.text]]) {
        const span = document.createElement('span'); span.className = className; span.textContent = value; row.append(span);
      }
      return row;
    });
    if (data.note) { const p = document.createElement('p'); p.className = 'code-notice'; p.textContent = data.note; nodes.push(p); }
    $('content').replaceChildren(...nodes);
  };
  state.worker.onerror = () => { $('content').removeAttribute('aria-busy'); notice('Falha ao calcular comparacao. Recarregue a pagina.'); };
}
function tick() {
  if (state.structureDirty) flatten();
  renderTree();
  $('topicCount').textContent = state.topicCount.toLocaleString('pt-BR');
  $('messageCount').textContent = state.totalMessages.toLocaleString('pt-BR');
  $('activity').textContent = state.paused ? 'Pausado' : state.totalMessages ? 'Recepcao ativa' : 'Aguardando mensagens';
  if (state.needsPage && performance.now() - state.lastFetch >= 350) loadPage();
}
function theme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('themeToggle').setAttribute('aria-pressed', String(dark));
}
$('themeToggle').onclick = () => {
  const value = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem('mqtt-web-theme', value); } catch {}
  theme();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
  try { if (localStorage.getItem('mqtt-web-theme')) return; } catch {}
  document.documentElement.dataset.theme = event.matches ? 'dark' : 'light'; theme();
});
$('searchInput').oninput = event => setFilter(event.target.value);
$('resetFilter').onclick = () => setFilter('');
$('collapseButton').onclick = () => { state.expanded.clear(); state.structureDirty = true; tick(); };
$('treeViewport').onscroll = renderTree;
new ResizeObserver(renderTree).observe($('treeViewport'));
$('previousPage').onclick = () => changePage(-1);
$('nextPage').onclick = () => changePage(1);
$('diffTab').onclick = () => { state.view = 'diff'; renderMessage(); };
$('payloadTab').onclick = () => { state.view = 'payload'; renderMessage(); };
$('liveButton').onclick = () => {
  if (state.follow) { state.follow = false; state.anchor = state.pageData?.messages[0]?.sequence ?? null; state.needsPage = false; state.request?.abort(); state.request = null; state.requestToken++; }
  else { state.follow = true; state.anchor = null; state.page = 1; state.needsPage = true; state.lastFetch = 0; }
  $('liveButton').setAttribute('aria-pressed', String(state.follow)); tick();
};
$('pauseButton').onclick = () => {
  state.paused = !state.paused;
  $('pauseButton').replaceChildren(icon(state.paused ? 'Play' : 'Pause'));
  $('pauseButton').setAttribute('aria-pressed', String(state.paused));
  $('pauseButton').title = state.paused ? 'Retomar atualizacao' : 'Pausar atualizacao';
  $('pauseButton').setAttribute('aria-label', $('pauseButton').title);
  if (state.paused) { state.socket?.close(); state.request?.abort(); state.request = null; state.requestToken++; showStatus(null); }
  else connect();
};
$('clearButton').onclick = async () => {
  $('clearButton').disabled = true;
  try {
    const response = await fetch('/api/clear', { method: 'POST' });
    if (!response.ok) throw new Error('Falha ao limpar mensagens');
    if (state.paused) { const res = await fetch('/api/state'); snapshot(await res.json()); }
  } catch (error) { notice(error.message); }
  finally { $('clearButton').disabled = false; }
};
$('copyButton').onclick = async () => {
  try { if (state.message) await navigator.clipboard.writeText(state.message.payload); $('copyButton').title = 'Copiado'; }
  catch { notice('Nao foi possivel copiar o payload.'); }
};
startWorker();
theme();
connect();
initializeConnectionDialog({
  onError: notice,
  onApplied: () => {
    state.expanded.clear();
    setFilter('');
    if (state.paused) $('pauseButton').click();
  },
});
setInterval(tick, 100);

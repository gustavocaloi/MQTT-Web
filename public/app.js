const elements = {
  topics: document.querySelector('#topics'),
  topicNodeTemplate: document.querySelector('#topicNodeTemplate'),
  messageTemplate: document.querySelector('#messageTemplate'),
  status: document.querySelector('#connectionStatus'),
  topicCount: document.querySelector('#topicCount'),
  messageCount: document.querySelector('#messageCount'),
  brokerUrl: document.querySelector('#brokerUrl'),
  topicFilter: document.querySelector('#topicFilter'),
  searchInput: document.querySelector('#searchInput'),
  pauseButton: document.querySelector('#pauseButton'),
  clearButton: document.querySelector('#clearButton'),
};

const state = {
  topics: new Map(),
  mqtt: null,
  topicCount: 0,
  totalMessages: 0,
  paused: false,
  queuedEvents: [],
  expandedPaths: new Set(),
  openedMessages: new Set(),
  unreadPaths: new Set(),
  pageByPath: new Map(),
  visibleChildrenByPath: new Map(),
  messagePages: new Map(),
  loadingPages: new Set(),
  limits: {
    messagesPerPage: 100,
    topicChildrenPerPage: 200,
  },
  query: '',
  renderQueued: false,
  renderTimer: null,
};

elements.searchInput.addEventListener('input', (event) => {
  state.query = event.target.value.trim().toLowerCase();
  scheduleRender();
});

elements.pauseButton.addEventListener('click', () => {
  state.paused = !state.paused;
  elements.pauseButton.setAttribute('aria-pressed', String(state.paused));
  elements.pauseButton.textContent = state.paused ? 'Retomar' : 'Pausar';

  if (!state.paused) {
    const events = state.queuedEvents.splice(0);
    events.forEach(applyEvent);
    scheduleRender();
  }
});

elements.clearButton.addEventListener('click', async () => {
  elements.clearButton.disabled = true;

  try {
    const response = await fetch('/api/clear', { method: 'POST' });
    if (!response.ok) throw new Error('Falha ao limpar mensagens');
  } finally {
    elements.clearButton.disabled = false;
  }
});

connect();

async function connect() {
  try {
    const response = await fetch('/api/state');
    applySnapshot(await response.json());
  } catch {
    setStatus({ connected: false, reconnecting: true, lastError: 'API indisponivel' });
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);

    if (state.paused && payload.type === 'message') {
      state.queuedEvents.push(payload);
      return;
    }

    applyEvent(payload);
    scheduleRender();
  });

  socket.addEventListener('close', () => {
    setStatus({ connected: false, reconnecting: true, lastError: 'Reconectando interface' });
    setTimeout(connect, 1500);
  });
}

function applyEvent(payload) {
  if (payload.type === 'snapshot') {
    applySnapshot(payload.data);
    return;
  }

  if (payload.type === 'status') {
    state.mqtt = payload.data;
    return;
  }

  if (payload.type === 'cleared') {
    applySnapshot(payload.data);
    return;
  }

  if (payload.type === 'message') {
    const topicName = payload.data.topic.topic;
    state.topics.set(topicName, payload.data.topic);
    state.totalMessages = payload.data.totalMessages;
    state.topicCount = payload.data.topicCount;
    markUnread(topicName);
    applyLiveMessage(topicName, payload.data.message);
  }
}

function applySnapshot(snapshot) {
  state.topics = new Map(snapshot.topics.map((topic) => [topic.topic, topic]));
  state.mqtt = snapshot.mqtt;
  state.topicCount = snapshot.topicCount;
  state.totalMessages = snapshot.totalMessages;
  resetLocalMessageState();
  state.limits = {
    ...state.limits,
    ...snapshot.limits,
  };
  scheduleRender();
}

function resetLocalMessageState() {
  state.expandedPaths.clear();
  state.openedMessages.clear();
  state.unreadPaths.clear();
  state.pageByPath.clear();
  state.visibleChildrenByPath.clear();
  state.messagePages.clear();
  state.loadingPages.clear();
  state.queuedEvents = [];
}

function markUnread(topicName) {
  getTopicSegments(topicName).reduce((prefix, segment) => {
    const path = prefix ? `${prefix}/${segment}` : segment;
    state.unreadPaths.add(path);
    return path;
  }, '');
}

function renderAll() {
  state.renderQueued = false;
  state.renderTimer = null;
  setStatus(state.mqtt);
  elements.topicCount.textContent = state.topicCount;
  elements.messageCount.textContent = state.totalMessages;
  elements.brokerUrl.textContent = state.mqtt?.url || '-';
  elements.topicFilter.textContent = state.mqtt?.topic || '#';
  renderTopics();
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  state.renderTimer = window.setTimeout(() => {
    window.requestAnimationFrame(renderAll);
  }, 100);
}

function setStatus(mqtt) {
  const connected = Boolean(mqtt?.connected);
  elements.status.classList.toggle('connected', connected);
  elements.status.classList.toggle('error', Boolean(mqtt?.lastError));
  elements.status.querySelector('strong').textContent = connected ? 'Online' : 'Offline';
  elements.status.querySelector('small').textContent = connected
    ? 'Recebendo em tempo real'
    : mqtt?.lastError || 'Reconectando';
}

function renderTopics() {
  const topics = Array.from(state.topics.values()).filter(matchesQuery);

  if (!topics.length) {
    elements.topics.innerHTML = `
      <div class="empty-state">
        <h2>${state.query ? 'Nada encontrado' : 'Nenhuma mensagem recebida ainda'}</h2>
        <p>${state.query ? 'Ajuste o filtro para ver outros topicos.' : 'Assim que o broker publicar algo no filtro configurado, os topicos aparecem aqui.'}</p>
      </div>
    `;
    return;
  }

  const tree = buildTopicTree(topics);
  const nodes = Array.from(tree.children.values())
    .sort(sortTreeNodes)
    .map((node) => renderTopicNode(node, 0));

  elements.topics.replaceChildren(...nodes);
}

function buildTopicTree(topics) {
  const root = createTreeNode('', '', null);

  for (const topic of topics) {
    const segments = getTopicSegments(topic.topic);
    let current = root;
    let path = '';

    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;

      if (!current.children.has(segment)) {
        current.children.set(segment, createTreeNode(segment, path, current));
      }

      current = current.children.get(segment);
      current.count += topic.count;
      current.retainedCount += topic.retainedCount;
      current.lastMessageAt = latestDate(current.lastMessageAt, topic.lastMessageAt);
    }

    current.topic = topic;
  }

  return root;
}

function createTreeNode(label, path, parent) {
  return {
    label,
    path,
    parent,
    topic: null,
    children: new Map(),
    count: 0,
    retainedCount: 0,
    lastMessageAt: null,
  };
}

function renderTopicNode(topicNode, depth) {
  const node = elements.topicNodeTemplate.content.firstElementChild.cloneNode(true);
  const row = node.querySelector('.topic-row');
  const toggle = node.querySelector('.topic-toggle');
  const filter = node.querySelector('.topic-filter');
  const title = node.querySelector('h2');
  const meta = node.querySelector('p');
  const count = node.querySelector('.topic-count');
  const children = node.querySelector('.topic-children');
  const hasChildren = topicNode.children.size > 0;
  const hasMessages = Boolean(topicNode.topic);
  const isExpanded = state.expandedPaths.has(topicNode.path);

  node.style.setProperty('--depth', depth);
  node.classList.toggle('expanded', isExpanded);
  node.classList.toggle('leaf', !hasChildren);
  node.classList.toggle('has-new', state.unreadPaths.has(topicNode.path));
  title.textContent = topicNode.label;
  meta.textContent = createTopicMeta(topicNode, hasChildren, hasMessages);
  count.textContent = topicNode.count;
  toggle.setAttribute('aria-expanded', String(isExpanded));

  toggle.addEventListener('click', () => {
    toggleTopic(topicNode.path);
  });

  filter.addEventListener('click', () => {
    applyTopicFilter(topicNode.path, hasChildren);
  });

  if (isExpanded) {
    const childrenValues = Array.from(topicNode.children.values()).sort(sortTreeNodes);
    const visibleChildren = getVisibleChildrenCount(topicNode.path);
    const childNodes = childrenValues
      .slice(0, visibleChildren)
      .map((child) => renderTopicNode(child, depth + 1));

    children.replaceChildren(...childNodes);

    if (childrenValues.length > visibleChildren) {
      children.append(renderMoreTopicsButton(topicNode.path, visibleChildren, childrenValues.length));
    }

    if (hasMessages) {
      const messages = document.createElement('div');
      messages.className = 'message-list';
      messages.replaceChildren(...renderPaginatedMessages(topicNode));
      children.append(messages);
    }
  }

  return node;
}

function applyTopicFilter(path, includeChildren) {
  const filterValue = includeChildren ? `${path}/#` : path;
  state.query = filterValue.toLowerCase();
  elements.searchInput.value = filterValue;
  state.expandedPaths.clear();
  state.visibleChildrenByPath.clear();
  expandPath(path);
  scheduleRender();
}

function expandPath(path) {
  getTopicSegments(path).reduce((prefix, segment) => {
    const nextPath = prefix ? `${prefix}/${segment}` : segment;
    state.expandedPaths.add(nextPath);
    return nextPath;
  }, '');
}

function toggleTopic(path) {
  if (state.expandedPaths.has(path)) {
    state.expandedPaths.delete(path);
  } else {
    state.expandedPaths.add(path);
  }

  clearUnreadBranch(path);
  renderTopics();
}

function renderPaginatedMessages(topicNode) {
  const pageSize = getMessagesPerPage();
  const totalMessages = topicNode.topic.storedMessages ?? topicNode.topic.count;
  const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));
  const currentPage = clampPage(state.pageByPath.get(topicNode.path) || 1, totalPages);
  const pageKey = createPageKey(topicNode.path, currentPage);
  const cachedPage = state.messagePages.get(pageKey);

  state.pageByPath.set(topicNode.path, currentPage);
  ensureMessagePage(topicNode.path, currentPage, pageSize);

  if (!cachedPage) {
    return [renderLoadingMessages()];
  }

  const pageMessages = cachedPage.messages.map(renderMessage);

  if (cachedPage.totalPages <= 1) {
    return pageMessages;
  }

  return [
    renderPagination(topicNode.path, cachedPage.page, cachedPage.totalPages, cachedPage.totalMessages, cachedPage.pageSize),
    ...pageMessages,
    renderPagination(topicNode.path, cachedPage.page, cachedPage.totalPages, cachedPage.totalMessages, cachedPage.pageSize),
  ];
}

function renderLoadingMessages() {
  const loading = document.createElement('div');
  loading.className = 'message-loading';
  loading.textContent = 'Carregando mensagens...';
  return loading;
}

function renderMoreTopicsButton(path, visibleChildren, totalChildren) {
  const wrapper = document.createElement('div');
  const button = document.createElement('button');
  const nextVisibleCount = Math.min(visibleChildren + getTopicChildrenPerPage(), totalChildren);

  wrapper.className = 'topic-more';
  button.type = 'button';
  button.textContent = `Mostrar mais topicos (${nextVisibleCount} de ${totalChildren})`;
  button.addEventListener('click', () => {
    state.visibleChildrenByPath.set(path, nextVisibleCount);
    renderTopics();
  });
  wrapper.append(button);
  return wrapper;
}

function renderPagination(path, currentPage, totalPages, totalMessages, pageSize) {
  const nav = document.createElement('nav');
  const previous = document.createElement('button');
  const next = document.createElement('button');
  const summary = document.createElement('span');

  nav.className = 'pagination';
  nav.setAttribute('aria-label', 'Paginacao de mensagens');
  previous.type = 'button';
  next.type = 'button';
  previous.textContent = 'Anterior';
  next.textContent = 'Proxima';
  previous.disabled = currentPage <= 1;
  next.disabled = currentPage >= totalPages;
  summary.textContent = `Pagina ${currentPage} de ${totalPages} - ${totalMessages} mensagens - ${pageSize} por pagina`;

  previous.addEventListener('click', () => {
    state.pageByPath.set(path, clampPage(currentPage - 1, totalPages));
    renderTopics();
  });

  next.addEventListener('click', () => {
    state.pageByPath.set(path, clampPage(currentPage + 1, totalPages));
    renderTopics();
  });

  nav.replaceChildren(previous, summary, next);
  return nav;
}

function clearUnreadBranch(path) {
  for (const unreadPath of Array.from(state.unreadPaths)) {
    if (unreadPath === path || unreadPath.startsWith(`${path}/`)) {
      state.unreadPaths.delete(unreadPath);
    }
  }
}

function renderMessage(message) {
  const node = elements.messageTemplate.content.firstElementChild.cloneNode(true);
  const summary = node.querySelector('.message-summary');
  const retained = node.querySelector('.retained');
  const badge = node.querySelector('.badge:not(.retained)');
  const pre = node.querySelector('pre');
  const isOpen = state.openedMessages.has(message.id);

  node.classList.toggle('open', isOpen);
  summary.setAttribute('aria-expanded', String(isOpen));
  node.querySelector('.message-time').textContent = formatDate(message.receivedAt);
  badge.textContent = `${message.payloadFormat} / qos ${message.qos} / ${formatBytes(message.payloadSize)}`;
  retained.hidden = !message.retained;
  pre.hidden = !isOpen;
  pre.textContent = formatPayload(message);

  summary.addEventListener('click', () => {
    if (state.openedMessages.has(message.id)) {
      state.openedMessages.delete(message.id);
    } else {
      state.openedMessages.add(message.id);
    }
    renderTopics();
  });

  return node;
}

function matchesQuery(topic) {
  if (!state.query) return true;

  return mqttTopicMatches(state.query, topic.topic);
}

function mqttTopicMatches(filter, topic) {
  const normalizedFilter = String(filter || '').trim();
  const normalizedTopic = String(topic || '');

  if (!isValidMqttFilter(normalizedFilter)) {
    return false;
  }

  if (
    normalizedTopic.startsWith('$')
    && !normalizedFilter.startsWith('$')
  ) {
    return false;
  }

  const filterSegments = normalizedFilter.toLowerCase().split('/');
  const topicSegments = normalizedTopic.toLowerCase().split('/');

  for (let index = 0; index < filterSegments.length; index += 1) {
    const filterSegment = filterSegments[index];
    const topicSegment = topicSegments[index];

    if (filterSegment === '#') {
      return index === filterSegments.length - 1;
    }

    if (topicSegment === undefined) {
      return false;
    }

    if (filterSegment !== '+' && filterSegment !== topicSegment) {
      return false;
    }
  }

  return filterSegments.length === topicSegments.length;
}

function isValidMqttFilter(filter) {
  if (!filter) return false;

  const segments = filter.split('/');

  return segments.every((segment, index) => {
    if (segment.includes('#')) {
      return segment === '#' && index === segments.length - 1;
    }

    if (segment.includes('+')) {
      return segment === '+';
    }

    return true;
  });
}

function getTopicSegments(topicName) {
  const segments = String(topicName || '').split('/').filter(Boolean);
  return segments.length ? segments : ['(sem topico)'];
}

function createTopicMeta(topicNode, hasChildren, hasMessages) {
  const parts = [];
  parts.push(`${hasChildren ? topicNode.children.size : 0} subtopicos`);
  if (hasMessages) parts.push(`${topicNode.topic.storedMessages ?? topicNode.topic.count} mensagens armazenadas`);
  parts.push(`${topicNode.retainedCount} retidas`);
  parts.push(formatDate(topicNode.lastMessageAt));
  return parts.join(' - ');
}

async function ensureMessagePage(topic, page, pageSize) {
  const pageKey = createPageKey(topic, page);
  if (state.messagePages.has(pageKey) || state.loadingPages.has(pageKey)) return;

  state.loadingPages.add(pageKey);

  try {
    const params = new URLSearchParams({
      topic,
      page: String(page),
      pageSize: String(pageSize),
    });
    const response = await fetch(`/api/messages?${params.toString()}`);
    if (!response.ok) throw new Error('Nao foi possivel carregar mensagens');

    state.messagePages.set(pageKey, await response.json());
  } catch {
    state.messagePages.set(pageKey, {
      topic,
      page,
      pageSize,
      totalMessages: 0,
      totalPages: 1,
      messages: [],
    });
  } finally {
    state.loadingPages.delete(pageKey);
    scheduleRender();
  }
}

function applyLiveMessage(topic, message) {
  const pageSize = getMessagesPerPage();
  const firstPageKey = createPageKey(topic, 1);
  const cachedPage = state.messagePages.get(firstPageKey);

  if (!cachedPage) return;

  const totalMessages = cachedPage.totalMessages + 1;
  state.messagePages.set(firstPageKey, {
    ...cachedPage,
    totalMessages,
    totalPages: Math.max(1, Math.ceil(totalMessages / pageSize)),
    messages: [message, ...cachedPage.messages].slice(0, pageSize),
  });
}

function createPageKey(topic, page) {
  return `${topic}::${page}`;
}

function getMessagesPerPage() {
  const value = Number(state.limits.messagesPerPage || 100);
  return Number.isFinite(value) && value > 0 ? value : 100;
}

function getTopicChildrenPerPage() {
  const value = Number(state.limits.topicChildrenPerPage || 200);
  return Number.isFinite(value) && value > 0 ? value : 200;
}

function getVisibleChildrenCount(path) {
  return state.visibleChildrenByPath.get(path) || getTopicChildrenPerPage();
}

function clampPage(page, totalPages) {
  return Math.min(Math.max(page, 1), totalPages);
}

function latestDate(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  return new Date(candidate) > new Date(current) ? candidate : current;
}

function sortTreeNodes(a, b) {
  return a.label.localeCompare(b.label, 'pt-BR', {
    numeric: true,
    sensitivity: 'base',
  });
}

function formatPayload(message) {
  if (message.payloadFormat !== 'json') {
    return message.truncated ? `${message.payload}\n... payload truncado` : message.payload;
  }

  try {
    const formatted = JSON.stringify(JSON.parse(message.payload), null, 2);
    return message.truncated ? `${formatted}\n... payload truncado` : formatted;
  } catch {
    return message.payload;
  }
}

function formatDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

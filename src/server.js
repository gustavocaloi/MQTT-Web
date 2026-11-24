import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import { WebSocket, WebSocketServer } from 'ws';
import { environmentConnection, publicConnection, validateConnection } from './mqtt-config.js';
import { topicMatches } from '../public/topic-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8080);
let connection;
let initialError = null;
try { connection = environmentConnection(); }
catch {
  connection = environmentConnection({});
  initialError = 'Configuracao MQTT do ambiente invalida.';
}
const MAX_MESSAGES_PER_TOPIC = Number(process.env.MAX_MESSAGES_PER_TOPIC || 100);
const MESSAGES_PER_PAGE = Number(process.env.MESSAGES_PER_PAGE || 100);
const TOPIC_CHILDREN_PER_PAGE = Number(process.env.TOPIC_CHILDREN_PER_PAGE || 200);
const MAX_PAYLOAD_PREVIEW = Number(process.env.MAX_PAYLOAD_PREVIEW || 64 * 1024);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const publicDir = path.join(__dirname, '..', 'public');
const imageDir = path.join(__dirname, '..', 'img');
const pendingTopics = new Map();
let generation = 0;
let sequence = 0;

app.get('/vendor/lucide.js', (_req, res) => res.sendFile(path.join(__dirname, '../node_modules/lucide/dist/umd/lucide.js')));
app.use('/vendor/diff', express.static(path.join(__dirname, '../node_modules/diff/libesm')));

const state = {
  mqtt: {
    url: connection.url,
    topic: connection.rootFilter,
    configured: Boolean(connection.url),
    connected: false,
    reconnecting: false,
    lastError: initialError,
  },
  topics: new Map(),
  totalMessages: 0,
  startedAt: new Date().toISOString(),
};

app.use(express.static(publicDir, {
  extensions: ['html'],
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

app.use('/img', express.static(imageDir, {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

app.get('/api/state', (_req, res) => {
  res.json(createSnapshot());
});

app.get('/api/connection', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicConnection(connection));
});

app.put('/api/connection', (req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origem nao permitida.' });
    } catch { return res.status(403).json({ error: 'Origem nao permitida.' }); }
  }
  if (!req.is('application/json')) return res.status(415).json({ error: 'Envie os dados em JSON.' });
  next();
}, express.json({ limit: '16kb' }), (req, res) => {
  let next;
  try { next = validateConnection(req.body, connection); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  replaceConnection(next);
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicConnection(connection));
});

app.use('/api/connection', (error, _req, res, _next) => {
  res.status(error.status === 413 ? 413 : 400).json({ error: 'Dados de conexao invalidos.' });
});

app.get('/api/messages', (req, res) => {
  const topic = String(req.query.topic || '');
  const pageSize = Math.min(200, normalizePositiveNumber(req.query.pageSize, MESSAGES_PER_PAGE));
  const page = normalizePositiveNumber(req.query.page, 1);
  const topicState = state.topics.get(topic);

  if (!topicState) {
    res.status(404).json({ error: 'Topic not found' });
    return;
  }

  const anchor = Number(req.query.before || Infinity);
  const available = topicState.messages.filter(message => message.sequence <= anchor);
  const totalMessages = available.length;
  const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;

  res.json({
    topic,
    page: currentPage,
    pageSize,
    totalMessages,
    totalPages,
    generation,
    version: topicState.count,
    messages: available.slice(start, start + pageSize),
    previous: available[start + pageSize] || null,
  });
});

app.post('/api/clear', (_req, res) => {
  clearMessages();
  broadcast({ type: 'cleared', data: createSnapshot() });
  res.json({ ok: true });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mqtt: state.mqtt,
  });
});

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'snapshot', data: createSnapshot() }));
});

let client = null;

function replaceConnection(next, reset = true) {
  const old = client;
  client = null;
  old?.end(true);
  connection = next;
  state.mqtt = { url: next.url, topic: next.rootFilter, configured: Boolean(next.url), connected: false, reconnecting: false, lastError: reset ? null : initialError };
  if (reset) {
    clearMessages();
    broadcast({ type: 'cleared', data: createSnapshot() });
  }
  if (!next.url) return;
  const current = mqtt.connect(next.url, {
    username: next.username || undefined,
    password: next.password || undefined,
    clientId: process.env.MQTT_CLIENT_ID || `mqtt-web-${Math.random().toString(16).slice(2)}`,
    clean: process.env.MQTT_CLEAN !== 'false',
    connectTimeout: Number(process.env.MQTT_CONNECT_TIMEOUT || 30_000),
    reconnectPeriod: Number(process.env.MQTT_RECONNECT_PERIOD || 2_000),
  });
  client = current;

  current.on('connect', () => {
    if (client !== current) return;
    state.mqtt.connected = true;
    state.mqtt.reconnecting = false;
    state.mqtt.lastError = null;

    current.subscribe(next.rootFilter, { qos: next.qos }, (error, granted) => {
      if (client !== current) return;
      if (error || granted?.some(subscription => subscription.qos === 128)) {
        updateMqttError();
        return;
      }
      broadcast({ type: 'status', data: state.mqtt });
    });
  });

  current.on('reconnect', () => {
    if (client !== current) return;
    state.mqtt.connected = false;
    state.mqtt.reconnecting = true;
    broadcast({ type: 'status', data: state.mqtt });
  });

  for (const event of ['close', 'offline']) current.on(event, () => {
    if (client !== current) return;
    state.mqtt.connected = false;
    broadcast({ type: 'status', data: state.mqtt });
  });

  current.on('error', () => { if (client === current) updateMqttError(); });

  current.on('message', (topic, payload, packet) => {
    if (client !== current || !topicMatches(next.rootFilter, topic)) return;
    const message = normalizeMessage(topic, payload, packet);
    const topicState = state.topics.get(topic) || {
      topic,
      count: 0,
      retainedCount: 0,
      lastMessageAt: null,
      messages: [],
    };
    topicState.count += 1;
    topicState.retainedCount += message.retained ? 1 : 0;
    topicState.lastMessageAt = message.receivedAt;
    topicState.messages.unshift(message);
    topicState.messages = topicState.messages.slice(0, MAX_MESSAGES_PER_TOPIC);

    state.totalMessages += 1;
    state.topics.set(topic, topicState);
    pendingTopics.set(topic, toTopicSummary(topicState));
  });
}

replaceConnection(connection, false);

// Coalesce busy topics and bound each WebSocket frame; history stays on the server.
setInterval(() => {
  if (!pendingTopics.size) return;
  const topics = Array.from(pendingTopics.values()).slice(0, 500);
  for (const topic of topics) pendingTopics.delete(topic.topic);
  broadcast({ type: 'batch', data: { topics, generation, totalMessages: state.totalMessages, topicCount: state.topics.size } });
}, 100).unref();

server.listen(PORT, () => {
  console.log(`mqtt-web listening on port ${server.address().port}`);
  console.log(connection.url ? 'MQTT configurado pelo ambiente' : 'Aguardando configuracao MQTT pela interface');
});

function updateMqttError() {
  state.mqtt.connected = false;
  state.mqtt.lastError = 'Falha na conexao ou assinatura MQTT. Confira o broker, as credenciais e o filtro.';
  broadcast({ type: 'status', data: state.mqtt });
}

function clearMessages() {
  generation += 1;
  pendingTopics.clear();
  state.topics.clear();
  state.totalMessages = 0;
}

function normalizeMessage(topic, payload, packet) {
  const raw = payload.toString('utf8');
  const truncated = raw.length > MAX_PAYLOAD_PREVIEW;
  const text = truncated ? raw.slice(0, MAX_PAYLOAD_PREVIEW) : raw;

  return {
    sequence: ++sequence,
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    topic,
    payload: text,
    payloadFormat: detectPayloadFormat(text),
    payloadSize: payload.length,
    truncated,
    qos: packet.qos,
    retained: packet.retain,
    duplicate: packet.dup,
    receivedAt: new Date().toISOString(),
  };
}

function detectPayloadFormat(value) {
  if (!value) return 'empty';

  try {
    JSON.parse(value);
    return 'json';
  } catch {
    return 'text';
  }
}

function createSnapshot() {
  const topics = Array.from(state.topics.values())
    .map(toTopicSummary)
    .sort((a, b) => a.topic.localeCompare(b.topic, 'pt-BR'));

  return {
    generation,
    mqtt: state.mqtt,
    topics,
    topicCount: topics.length,
    totalMessages: state.totalMessages,
    startedAt: state.startedAt,
    limits: {
      maxMessagesPerTopic: MAX_MESSAGES_PER_TOPIC,
      messagesPerPage: MESSAGES_PER_PAGE,
      topicChildrenPerPage: TOPIC_CHILDREN_PER_PAGE,
      maxPayloadPreview: MAX_PAYLOAD_PREVIEW,
    },
  };
}

function toTopicSummary(topicState) {
  return {
    topic: topicState.topic,
    count: topicState.count,
    retainedCount: topicState.retainedCount,
    lastMessageAt: topicState.lastMessageAt,
    storedMessages: topicState.messages.length,
  };
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value || fallback);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function broadcast(payload) {
  const data = JSON.stringify(payload);

  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) {
      if (socket.bufferedAmount > 2 * 1024 * 1024) {
        socket.terminate();
        continue;
      }
      socket.send(data);
    }
  }
}

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import { WebSocket, WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8080);
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const MQTT_ROOT_FILTER = process.env.MQTT_ROOT_FILTER || process.env.MQTT_TOPIC || '#';
const MQTT_USERNAME = process.env.MQTT_USERNAME || undefined;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || undefined;
const MAX_MESSAGES_PER_TOPIC = Number(process.env.MAX_MESSAGES_PER_TOPIC || 100);
const MESSAGES_PER_PAGE = Number(process.env.MESSAGES_PER_PAGE || 100);
const TOPIC_CHILDREN_PER_PAGE = Number(process.env.TOPIC_CHILDREN_PER_PAGE || 200);
const MAX_PAYLOAD_PREVIEW = Number(process.env.MAX_PAYLOAD_PREVIEW || 64 * 1024);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const publicDir = path.join(__dirname, '..', 'public');

const state = {
  mqtt: {
    url: sanitizeBrokerUrl(MQTT_URL),
    topic: MQTT_ROOT_FILTER,
    connected: false,
    reconnecting: false,
    lastError: null,
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

app.get('/api/state', (_req, res) => {
  res.json(createSnapshot());
});

app.get('/api/messages', (req, res) => {
  const topic = String(req.query.topic || '');
  const pageSize = normalizePositiveNumber(req.query.pageSize, MESSAGES_PER_PAGE);
  const page = normalizePositiveNumber(req.query.page, 1);
  const topicState = state.topics.get(topic);

  if (!topicState) {
    res.status(404).json({ error: 'Topic not found' });
    return;
  }

  const totalMessages = topicState.messages.length;
  const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;

  res.json({
    topic,
    page: currentPage,
    pageSize,
    totalMessages,
    totalPages,
    messages: topicState.messages.slice(start, start + pageSize),
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

const client = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  clientId: process.env.MQTT_CLIENT_ID || `mqtt-web-${Math.random().toString(16).slice(2)}`,
  clean: process.env.MQTT_CLEAN !== 'false',
  connectTimeout: Number(process.env.MQTT_CONNECT_TIMEOUT || 30_000),
  reconnectPeriod: Number(process.env.MQTT_RECONNECT_PERIOD || 2_000),
});

client.on('connect', () => {
  state.mqtt.connected = true;
  state.mqtt.reconnecting = false;
  state.mqtt.lastError = null;

  client.subscribe(MQTT_ROOT_FILTER, { qos: Number(process.env.MQTT_QOS || 0) }, (error) => {
    if (error) {
      updateMqttError(error);
      return;
    }

    broadcast({ type: 'status', data: state.mqtt });
  });
});

client.on('reconnect', () => {
  state.mqtt.connected = false;
  state.mqtt.reconnecting = true;
  broadcast({ type: 'status', data: state.mqtt });
});

client.on('close', () => {
  state.mqtt.connected = false;
  broadcast({ type: 'status', data: state.mqtt });
});

client.on('offline', () => {
  state.mqtt.connected = false;
  broadcast({ type: 'status', data: state.mqtt });
});

client.on('error', updateMqttError);

client.on('message', (topic, payload, packet) => {
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

  broadcast({
    type: 'message',
    data: {
      message,
      topic: toTopicSummary(topicState),
      totalMessages: state.totalMessages,
      topicCount: state.topics.size,
    },
  });
});

server.listen(PORT, () => {
  console.log(`mqtt-web listening on port ${PORT}`);
  console.log(`subscribing to ${MQTT_ROOT_FILTER} on ${sanitizeBrokerUrl(MQTT_URL)}`);
});

function updateMqttError(error) {
  state.mqtt.connected = false;
  state.mqtt.lastError = error.message;
  broadcast({ type: 'status', data: state.mqtt });
}

function clearMessages() {
  state.topics.clear();
  state.totalMessages = 0;
}

function normalizeMessage(topic, payload, packet) {
  const raw = payload.toString('utf8');
  const truncated = raw.length > MAX_PAYLOAD_PREVIEW;
  const text = truncated ? raw.slice(0, MAX_PAYLOAD_PREVIEW) : raw;

  return {
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
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function broadcast(payload) {
  const data = JSON.stringify(payload);

  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  }
}

function sanitizeBrokerUrl(value) {
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    if (url.username) url.username = '***';
    return url.toString();
  } catch {
    return value;
  }
}

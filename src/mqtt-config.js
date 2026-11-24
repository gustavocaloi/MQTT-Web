import { validFilter } from '../public/topic-filter.js';

export function validateConnection(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuracao invalida.');
  for (const field of ['url', 'username', 'rootFilter']) {
    if (typeof input[field] !== 'string') throw new Error('Preencha os dados da conexao.');
  }
  let url;
  try { url = new URL(input.url.trim()); } catch { throw new Error('Informe uma URL de broker valida.'); }
  if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.hash || input.url.length > 2048) {
    throw new Error('Use uma URL mqtt://, mqtts://, ws:// ou wss://.');
  }
  if (url.username || url.password) throw new Error('Informe usuario e senha nos campos separados.');
  if (!validFilter(input.rootFilter) || Buffer.byteLength(input.rootFilter) > 65535) throw new Error('Filtro raiz MQTT invalido.');
  if (![0, 1, 2].includes(input.qos)) throw new Error('O QoS deve ser 0, 1 ou 2.');
  if (input.username.length > 1024 || input.username.includes('\0')) throw new Error('Usuario invalido.');
  // Never forward an existing secret to a different broker or account.
  const sameAccount = previous.url === url.href && previous.username === input.username;
  const password = input.password === undefined ? (sameAccount ? previous.password || '' : '') : input.password;
  if (typeof password !== 'string' || password.length > 4096) throw new Error('Senha invalida.');
  return { url: url.href, username: input.username, password, rootFilter: input.rootFilter, qos: input.qos };
}

export function environmentConnection(env = process.env) {
  const config = {
    url: (env.MQTT_URL || '').trim(), username: env.MQTT_USERNAME || '', password: env.MQTT_PASSWORD || '',
    rootFilter: env.MQTT_ROOT_FILTER || env.MQTT_TOPIC || '#', qos: Number(env.MQTT_QOS || 0),
  };
  if (!config.url) return config;
  const url = new URL(config.url);
  config.username ||= decodeURIComponent(url.username);
  config.password ||= decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  config.url = url.href;
  return validateConnection(config);
}

export function publicConnection(config) {
  return { url: config.url, username: config.username, rootFilter: config.rootFilter, qos: config.qos,
    hasPassword: Boolean(config.password), configured: Boolean(config.url) };
}

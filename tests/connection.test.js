import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { chromium, expect } from '@playwright/test';
import { environmentConnection, publicConnection, validateConnection } from '../src/mqtt-config.js';

test('connection validation and secret handling', () => {
  const input = { url: 'mqtt://localhost:1883', username: 'operator', password: 'secret', rootFilter: 'flight/+/test', qos: 1 };
  const config = validateConnection(input);
  assert.equal(validateConnection({ ...input, password: undefined }, config).password, 'secret');
  assert.equal(validateConnection({ ...input, password: undefined, url: 'mqtt://localhost:1884' }, config).password, '');
  assert.equal(validateConnection({ ...input, password: undefined, username: 'another' }, config).password, '');
  assert.equal(validateConnection({ ...input, password: '' }, config).password, '');
  assert.equal(publicConnection(config).hasPassword, true);
  assert.ok(!JSON.stringify(publicConnection(config)).includes('secret'));
  for (const change of [{ url: 'file:///etc/passwd' }, { url: 'mqtt://user:secret@localhost' }, { rootFilter: 'a/#/b' }, { qos: 3 }, { qos: '1' }, { password: 42 }]) {
    assert.throws(() => validateConnection({ ...input, ...change }));
  }
  assert.equal(publicConnection(environmentConnection({})).configured, false);
  const fromEnv = environmentConnection({ MQTT_URL: 'mqtt://operator:secret@localhost:1883', MQTT_TOPIC: 'flight/#' });
  assert.equal(fromEnv.password, 'secret');
  assert.equal(fromEnv.rootFilter, 'flight/#');
  assert.ok(!fromEnv.url.includes('secret'));
});

async function startApp() {
  const app = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: '0', MQTT_URL: '', MQTT_USERNAME: '', MQTT_PASSWORD: '', MQTT_ROOT_FILTER: '#', MQTT_QOS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise((resolve, reject) => {
    let log = '';
    app.stdout.on('data', data => {
      log += data;
      const match = log.match(/listening on port (\d+)/);
      if (match) resolve('http://127.0.0.1:' + match[1]);
    });
    app.once('error', reject);
    app.once('exit', () => reject(new Error('Server exited before listening')));
  });
  return { app, base };
}

async function stopApp(app) {
  if (!app || app.exitCode !== null || app.signalCode !== null) return;
  const exited = once(app, 'exit');
  app.kill('SIGTERM');
  await exited;
}

test('connection popup, authentication, broker replacement and restart', { timeout: 180000 }, async () => {
  const brokers = [];
  const publishers = [];
  let running, browser;
  try {
    for (let i = 0; i < 2; i++) {
      const broker = await Aedes.createBroker();
      if (i === 0) broker.authenticate = (_client, username, password, done) => done(null, username === 'operator' && password?.toString() === 'secret');
      const tcp = net.createServer(broker.handle);
      tcp.listen(0, '127.0.0.1');
      await once(tcp, 'listening');
      const url = 'mqtt://127.0.0.1:' + tcp.address().port;
      brokers.push({ broker, tcp, url });
      publishers.push(await mqtt.connectAsync(url, { username: 'operator', password: 'secret' }));
    }
    running = await startApp();
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(running.base, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('#connectionDialog')).toBeVisible();
    await expect(page.locator('#connectionRootFilter')).toHaveValue('#');
    await expect(page.locator('#connectionUrl')).toHaveValue('');
    const settings = await page.request.get(running.base + '/api/connection');
    assert.equal(settings.headers()['cache-control'], 'no-store');
    assert.equal((await settings.json()).configured, false);
    const invalid = await page.request.put(running.base + '/api/connection', { data: { url: 'file:///tmp', username: '', rootFilter: '#', qos: 0 } });
    assert.equal(invalid.status(), 400);
    const foreign = await page.request.put(running.base + '/api/connection', { headers: { Origin: 'https://untrusted.example' }, data: {} });
    assert.equal(foreign.status(), 403);

    await page.locator('#connectionUrl').fill(brokers[0].url);
    await page.locator('#connectionUsername').fill('operator');
    await page.locator('#connectionPassword').fill('secret');
    await page.locator('#connectionRootFilter').fill('factory/#');
    await page.locator('#connectionQos').selectOption('1');
    await page.locator('#saveConnection').click();
    await expect(page.locator('#connectionDialog')).toBeHidden();
    await expect(page.locator('#connectionStatus')).toHaveText('Conectado');
    await publishers[0].publishAsync('factory/temperature', '24', { qos: 1 });
    await expect(page.locator('#topicCount')).toHaveText('1');
    for (const name of ['factory', 'temperature']) await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('#selectedTopic')).toHaveText('factory/temperature');
    await expect(page.locator('#historyRows tr')).toHaveCount(1);

    await page.locator('#connectionButton').click();
    await expect(page.locator('#connectionPassword')).toHaveValue('');
    await expect(page.locator('#connectionPassword')).toHaveAttribute('placeholder', 'Manter senha atual');
    const safe = await (await page.request.get(running.base + '/api/connection')).json();
    assert.equal(safe.hasPassword, true);
    assert.ok(!JSON.stringify(safe).includes('secret'));
    await page.locator('#connectionRootFilter').fill('factory/#/bad');
    await page.locator('#saveConnection').click();
    await expect(page.locator('#connectionError')).toBeVisible();
    await expect(page.locator('#topicCount')).toHaveText('1');
    await page.locator('#connectionRootFilter').fill('factory/+');
    await page.locator('#saveConnection').click();
    await expect(page.locator('#connectionDialog')).toBeHidden();
    await expect(page.locator('#topicFilter')).toHaveText('factory/+');
    await expect(page.locator('#connectionStatus')).toHaveText('Conectado');
    await publishers[0].publishAsync('factory/deep/hidden', 'hidden', { qos: 1 });
    await publishers[0].publishAsync('factory/second', '25', { qos: 1 });
    await expect(page.locator('#topicCount')).toHaveText('1');
    assert.deepEqual((await (await page.request.get(running.base + '/api/state')).json()).topics.map(topic => topic.topic), ['factory/second']);
    assert.equal((await (await page.request.get(running.base + '/api/connection')).json()).hasPassword, true);
    await page.locator('#connectionButton').click();
    await page.locator('#connectionRootFilter').fill('other/#');
    await page.locator('#connectionUrl').fill(brokers[1].url);
    await page.locator('#saveConnection').click();
    await expect(page.locator('#connectionStatus')).toHaveText('Conectado');
    await expect(page.locator('#brokerUrl')).toHaveText(brokers[1].url);
    await expect(page.locator('#topicCount')).toHaveText('0');
    await expect(page.locator('#detail')).toBeHidden();
    assert.equal((await (await page.request.get(running.base + '/api/connection')).json()).hasPassword, false);
    await publishers[0].publishAsync('factory/old', 'old', { qos: 1 });
    await publishers[1].publishAsync('other/new', 'new', { qos: 1 });
    await expect(page.locator('#topicCount')).toHaveText('1');
    const snapshot = await (await page.request.get(running.base + '/api/state')).json();
    assert.deepEqual(snapshot.topics.map(topic => topic.topic), ['other/new']);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('#connectionStatus')).toHaveText('Conectado');
    await expect(page.locator('#connectionDialog')).toBeHidden();
    await page.locator('#connectionButton').click();
    await expect(page.locator('#connectionDialog')).toBeVisible();
    mkdirSync('test-results', { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await page.screenshot({ path: `test-results/connection-${theme}.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'test-results/connection-mobile.png' });
    assert(await page.locator('#connectionDialog').evaluate(el => el.scrollWidth <= el.clientWidth));
    await stopApp(running.app);
    running = await startApp();
    await page.goto(running.base, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('#connectionDialog')).toBeVisible();
    await expect(page.locator('#connectionUrl')).toHaveValue('');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopApp(running?.app);
    for (const publisher of publishers) await publisher.endAsync(true);
    for (const { broker, tcp } of brokers) {
      await broker.close();
      await new Promise(resolve => tcp.close(resolve));
    }
  }
});

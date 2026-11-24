import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { chromium, expect } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { topicMatches } from '../public/topic-filter.js';

test('MQTT filters preserve case and empty levels', () => {
  for (const [filter, topic, result] of [
    ['flight/+/teste', 'flight/live/teste', true],
    ['flight/#', 'flight', true], ['a/+/b', 'a//b', true],
    ['A/#', 'a/b', false], ['#', '$SYS/status', false],
    ['$SYS/#', '$SYS/status', true], ['a/#/b', 'a/c/b', false],
  ]) assert.equal(topicMatches(filter, topic), result);
});

test('live explorer, diff, pagination, bounded tree and reset', { timeout: 90000 }, async () => {
  const broker = await Aedes.createBroker();
  const tcp = net.createServer(broker.handle);
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  const mqttUrl = 'mqtt://127.0.0.1:' + tcp.address().port;
  const app = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, MQTT_URL: mqttUrl, PORT: '0', MAX_MESSAGES_PER_TOPIC: '500', MESSAGES_PER_PAGE: '5' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser, publisher;
  try {
    const base = await new Promise((resolve, reject) => {
      let log = '';
      app.stdout.on('data', data => { log += data; const match = log.match(/listening on port (\d+)/); if (match) resolve('http://127.0.0.1:' + match[1]); });
      app.once('exit', code => reject(new Error('server exited ' + code)));
    });
    publisher = await mqtt.connectAsync(mqttUrl);
    await new Promise(resolve => setTimeout(resolve, 250));
    const publish = (topic, value) => publisher.publishAsync(topic, JSON.stringify(value), { qos: 1 });
    for (let i = 0; i < 12; i++) await publish('factory/room/temperature', { temperature: i, status: 'ok' });
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await expect(page.locator('#connectionStatus')).toHaveText('Conectado');
    for (const label of ['factory', 'room', 'temperature', 'Payload']) await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('#selectedTopic')).toHaveText('factory/room/temperature');
    await expect(page.locator('.code-line.add')).toContainText(['11']);
    await expect(page.locator('.code-line.remove')).toContainText(['10']);
    await expect(page.locator('#historyRows tr')).toHaveCount(5);
    await page.locator('#nextPage').click();
    await expect(page.locator('#pageLabel')).toHaveText('2 / 3');
    await page.locator('#historyRows button').last().click();
    await expect(page.locator('.code-line.add')).toContainText(['2']);
    await expect(page.locator('.code-line.remove')).toContainText(['1']);
    const frozen = await page.locator('#content').textContent();
    await publish('factory/room/temperature', { temperature: 100 });
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#content').textContent(), frozen);
    await page.locator('#liveButton').click();
    await expect(page.locator('.code-line.add')).toContainText(['100']);
    await page.locator('#pauseButton').click();
    for (let i = 0; i < 5000; i++) publisher.publish('load/sensor' + i, String(i));
    await new Promise(resolve => setTimeout(resolve, 800));
    await page.locator('#pauseButton').click();
    await expect(page.locator('#topicCount')).toHaveText('5.001', { timeout: 15000 });
    await page.getByRole('button', { name: 'load', exact: true }).click();
    assert(await page.locator('.tree-row').count() < 60);
    await page.locator('#treeViewport').evaluate(el => el.scrollTop = 100000);
    await page.waitForTimeout(200);
    assert(await page.locator('.tree-row').count() < 60);
    const flood = setInterval(() => {
      for (let i = 0; i < 100; i++) publisher.publish('load/sensor' + (i % 50), String(Date.now()));
    }, 20);
    try {
      await page.locator('#searchInput').fill('factory/#');
      await page.getByRole('button', { name: 'Payload', exact: true }).click({ timeout: 2000 });
      await page.locator('#payloadTab').click({ timeout: 2000 });
    } finally { clearInterval(flood); }
    await page.waitForTimeout(1300);
    assert.equal(await page.locator('.tree-row.active').count(), 0);
    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
    await page.locator('#themeToggle').click();
    await page.screenshot({ path: 'test-results/dark.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('#clearButton').click();
    await expect(page.locator('#topicCount')).toHaveText('0');
    await expect(page.locator('#detail')).toBeHidden();
    await publish('factory/room/temperature', { temperature: 1 });
    await expect(page.locator('#topicCount')).toHaveText('1');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await publisher?.endAsync(true);
    app.kill('SIGTERM');
    await once(app, 'exit');
    await broker.close();
    await new Promise(resolve => tcp.close(resolve));
  }
});

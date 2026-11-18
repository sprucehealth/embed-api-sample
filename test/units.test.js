import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createMediaHostCheck } from '../server/attachments.js';
import { createSessions, createThrottle, hashPassword, verifyPassword } from '../server/auth.js';
import { loadConfig, normalizeCredential, parseFlags } from '../server/config.js';
import { createEventHub } from '../server/events.js';
import { EmailTakenError, openStore } from '../server/store.js';
import { signPayload, verifySignature } from '../server/webhooks.js';

test('signature matches the documented Base64 HMAC-SHA256 of the raw body', () => {
  const body = Buffer.from('{"object":"event"}');
  const documented = createHmac('sha256', 'secret').update(body).digest('base64');
  assert.equal(signPayload('secret', body), documented);
  assert.equal(verifySignature('secret', body, documented), true);
  assert.equal(verifySignature('other', body, documented), false);
  assert.equal(verifySignature('secret', Buffer.from('{"object":"event" }'), documented), false);
  assert.equal(verifySignature('secret', body, ''), false);
  assert.equal(verifySignature('secret', body, undefined), false);
  assert.equal(verifySignature('secret', body, 'not base64!'), false);
});

test('passwords verify only against their own hash', async () => {
  const hash = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong horse', hash), false);
  assert.equal(await verifyPassword('correct horse', 'garbage'), false);
  assert.notEqual(hash, await hashPassword('correct horse'));
});

test('sessions expire', () => {
  let now = 1000;
  const sessions = createSessions({ ttlMs: 500, now: () => now });
  const id = sessions.create('patient-1');
  assert.equal(sessions.get(id).patientId, 'patient-1');
  now = 1600;
  assert.equal(sessions.get(id), null);
  assert.equal(sessions.get('unknown'), null);
});

test('an expired session is reported once, with the device it signed in on', () => {
  let now = 1000;
  const expired = [];
  const sessions = createSessions({ ttlMs: 500, now: () => now, onExpire: (session) => expired.push(session) });
  const first = sessions.create('patient-1', 'device-a');
  now = 1300;
  sessions.create('patient-1', 'device-b');
  assert.equal(sessions.usesDevice('patient-1', 'device-a'), true);
  now = 1600;
  assert.equal(sessions.sweep().length, 1);
  assert.deepEqual(expired.map((session) => [session.id, session.deviceId]), [[first, 'device-a']]);
  assert.equal(sessions.usesDevice('patient-1', 'device-a'), false);
  assert.equal(sessions.usesDevice('patient-1', 'device-b'), true);
  assert.equal(sessions.get(first), null);
  assert.equal(expired.length, 1);

  // A session that is signed out is not reported: the sign-out route revokes its token itself.
  sessions.destroy(sessions.create('patient-2', 'device-c'));
  now = 5000;
  sessions.sweep();
  assert.deepEqual(expired.map((session) => session.deviceId), ['device-a', 'device-b']);
});

test('a failed store write changes nothing in memory and does not block the next write', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'embed-sample-store-'));
  try {
    const store = await openStore(dir);
    const pat = await store.createPatient({ email: 'pat@example.com', contactId: '' });
    // A directory where the temporary file belongs makes every write fail until it is removed.
    await mkdir(path.join(dir, 'store.json.tmp'));
    await assert.rejects(store.createPatient({ email: 'sam@example.com' }), { code: 'EISDIR' });
    await assert.rejects(store.updatePatient(pat.id, { contactId: 'entity_c1' }), { code: 'EISDIR' });
    await assert.rejects(store.deletePatient(pat.id), { code: 'EISDIR' });
    assert.equal(store.patientByEmail('sam@example.com'), null);
    assert.equal(store.patientById(pat.id).contactId, '');

    await rmdir(path.join(dir, 'store.json.tmp'));
    const sam = await store.createPatient({ email: 'sam@example.com' });
    const saved = JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8'));
    assert.deepEqual(saved.patients.map((patient) => patient.id), [pat.id, sam.id]);
    assert.equal((await openStore(dir)).patientByEmail('sam@example.com').id, sam.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the store refuses a second account for one email, even when both are created together', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'embed-sample-store-'));
  try {
    const store = await openStore(dir);
    const results = await Promise.allSettled([store.createPatient({ email: 'pat@example.com' }), store.createPatient({ email: 'pat@example.com' })]);
    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
    assert.ok(results[1].reason instanceof EmailTakenError);
    assert.equal(store.listPatients().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publishing straight after a stream is closed does not throw, and closing one session leaves the others open', async () => {
  const hub = createEventHub();
  let opened = 0;
  const server = http.createServer((req, res) => {
    hub.subscribe('p1', req, res, { sessionId: req.url.slice(1), until: Date.now() + 60000 });
    opened += 1;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // An error on a response nobody listens to would surface here as an uncaught exception.
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    const decoder = new TextDecoder();
    const open = async (session) => {
      const reader = (await fetch(`${base}/${session}`)).body.getReader();
      await reader.read();
      return reader;
    };
    const first = await open('s1');
    const second = await open('s2');
    assert.equal(opened, 2);

    hub.closeSession('p1', 's1');
    hub.publish('p1', 'notification', { n: 1 });
    assert.equal((await first.read()).done, true);
    assert.match(decoder.decode((await second.read()).value), /event: notification\ndata: \{"n":1\}/);

    hub.closePatient('p1');
    hub.publish('p1', 'notification', { n: 2 });
    assert.equal((await second.read()).done, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off('uncaughtException', onUncaught);
    hub.closeAll();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
});

test('the attachment proxy fetches only from the Spruce hosts, their domain, or a listed media host', () => {
  const production = createMediaHostCheck({ apiUrl: 'https://api.sprucehealth.com/v1', embedUrl: 'https://embed.sprucehealth.com/v1' });
  assert.equal(production('https://media.sprucehealth.com/media/abc?sig=1'), true);
  assert.equal(production('https://api.sprucehealth.com/v1/x'), true);
  assert.equal(production('http://media.sprucehealth.com/media/abc'), false);
  assert.equal(production('https://sprucehealth.com.attacker.example/media/abc'), false);
  assert.equal(production('https://attackersprucehealth.com/media/abc'), false);
  assert.equal(production('https://169.254.169.254/latest'), false);
  assert.equal(production('http://127.0.0.1:8080/admin'), false);
  assert.equal(production('not a url'), false);

  // An IP address is not a domain name: its neighbours are not its subdomains.
  const byAddress = createMediaHostCheck({ apiUrl: 'https://10.0.0.5/v1', embedUrl: 'https://10.0.0.5/v1' });
  assert.equal(byAddress('https://10.0.0.5/media/abc'), true);
  assert.equal(byAddress('https://99.0.0.5/media/abc'), false);

  const local = createMediaHostCheck({ apiUrl: 'http://127.0.0.1:5001/api/v1', embedUrl: 'http://127.0.0.1:5001/embed/v1', mediaHosts: ['cdn.example.net'] });
  assert.equal(local('http://127.0.0.1:5001/media/m1'), true);
  assert.equal(local('http://127.0.0.1:5002/media/m1'), false);
  assert.equal(local('http://localhost:5001/media/m1'), false);
  assert.equal(local('https://cdn.example.net/media/m1'), true);
  assert.equal(local('https://other.example.net/media/m1'), false);
});

test('throttle blocks at the limit and resets after the window', () => {
  let now = 0;
  const throttle = createThrottle({ limit: 2, windowMs: 100, now: () => now });
  throttle.fail('k');
  assert.equal(throttle.blocked('k'), false);
  throttle.fail('k');
  assert.equal(throttle.blocked('k'), true);
  now = 200;
  assert.equal(throttle.blocked('k'), false);
});

test('credential accepts a token or an id:secret pair', () => {
  assert.equal(normalizeCredential('  abc123  '), 'abc123');
  assert.equal(normalizeCredential('id:secret'), Buffer.from('id:secret').toString('base64'));
  assert.throws(() => normalizeCredential('  '));
});

test('hosts default to production and are overridable by flag or environment', async () => {
  const prompt = async () => 'token';
  const defaults = await loadConfig({ env: {}, prompt });
  assert.equal(defaults.apiUrl, 'https://api.sprucehealth.com/v1');
  assert.equal(defaults.embedUrl, 'https://embed.sprucehealth.com/v1');
  assert.equal(defaults.port, 4400);

  const fromEnv = await loadConfig({ env: { SPRUCE_API_URL: 'https://api.example.test/v1/', SPRUCE_EMBED_URL: 'https://embed.example.test/v1' }, prompt });
  assert.equal(fromEnv.apiUrl, 'https://api.example.test/v1');
  assert.equal(fromEnv.embedUrl, 'https://embed.example.test/v1');

  const fromFlags = await loadConfig({
    env: { SPRUCE_API_URL: 'https://api.example.test/v1' },
    argv: ['--api-url', 'https://api.flag.test/v1', '--embed-url=https://embed.flag.test/v1', '--port', '5000'],
    prompt,
  });
  assert.equal(fromFlags.apiUrl, 'https://api.flag.test/v1');
  assert.equal(fromFlags.embedUrl, 'https://embed.flag.test/v1');
  assert.equal(fromFlags.port, 5000);

  await assert.rejects(loadConfig({ env: { SPRUCE_API_URL: 'http://api.example.test/v1' }, prompt }), /https/);
  assert.deepEqual(defaults.mediaHosts, []);
  assert.deepEqual((await loadConfig({ env: { SPRUCE_MEDIA_HOSTS: 'media.example.test, cdn.example.test' }, prompt })).mediaHosts, ['media.example.test', 'cdn.example.test']);
  await assert.rejects(loadConfig({ env: { SPRUCE_MEDIA_HOSTS: 'https://media.example.test/' }, prompt }), /SPRUCE_MEDIA_HOSTS/);
  assert.throws(() => parseFlags(['--token', 'x']), /Unknown flag/);
});

test('the credential is prompted for, and is not printed with the config', async () => {
  let asked = 0;
  const config = await loadConfig({
    env: {},
    prompt: async () => {
      asked += 1;
      return 'super-secret';
    },
  });
  assert.equal(asked, 1);
  assert.equal(config.credential, 'super-secret');
  assert.ok(!JSON.stringify(config).includes('super-secret'));
  assert.ok(!Object.keys(config).includes('credential'));

  // A token in the environment is ignored, and the webhook secret is new on every load.
  const again = await loadConfig({ env: { SPRUCE_API_TOKEN: 'env-token', SPRUCE_WEBHOOK_SECRET: 'env-secret' }, prompt: async () => 'typed-token' });
  assert.equal(again.credential, 'typed-token');
  assert.notEqual(again.webhookSecret, 'env-secret');
  assert.notEqual(again.webhookSecret, config.webhookSecret);
});

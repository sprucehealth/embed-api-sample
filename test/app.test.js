import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rmdir, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { ApiError } from '../public/api.js';
import { deliverMessage } from '../public/send.js';
import { hashPassword } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { createPracticeClient } from '../server/spruce/practice.js';
import { openStore } from '../server/store.js';
import { signPayload } from '../server/webhooks.js';
import { startFakeSpruce } from './fake-spruce.js';

const WEBHOOK_SECRET = 'test-webhook-secret';

// A minimal browser stand-in: it keeps cookies and sends the Origin header a same-origin page would.
function browser(origin) {
  const jar = new Map();
  return async function request(method, pathname, { json, body, headers = {}, raw = false } = {}) {
    const res = await fetch(origin + pathname, {
      method,
      headers: {
        Origin: origin,
        Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: json ? JSON.stringify(json) : body,
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    if (raw) return res;
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, setCookies: res.headers.getSetCookie() };
  };
}

describe('sample app against a fake Spruce', () => {
  let spruce;
  let app;
  let origin;
  let dataDir;
  let store;
  let pat;
  const logs = [];
  // Added to the clock the sessions read, so a test can let them expire.
  let clockSkewMs = 0;

  before(async () => {
    spruce = await startFakeSpruce();
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'embed-sample-'));
    store = await openStore(dataDir);
    const config = { apiUrl: spruce.apiUrl, embedUrl: spruce.embedUrl, webhookSecret: WEBHOOK_SECRET };
    const practice = createPracticeClient({ baseUrl: spruce.apiUrl, credential: spruce.state.credential });
    app = createApp({
      config,
      store,
      practice,
      organization: await practice.organization(),
      internalEndpointId: 'link_1',
      log: (line) => logs.push(line),
      now: () => Date.now() + clockSkewMs,
    });
    await app.listen(0);
    origin = app.origin();
    pat = browser(origin);
  });

  after(async () => {
    await app.close();
    await spruce.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const webhook = (event, secret = WEBHOOK_SECRET) => {
    const payload = JSON.stringify(event);
    return fetch(origin + '/webhooks/spruce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Spruce-Signature': signPayload(secret, payload) },
      body: payload,
    });
  };

  // Opens the patient's event stream and resolves with the first event of the wanted name.
  async function nextEvent(client, name, trigger) {
    const res = await client('GET', '/api/events', { raw: true });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = decoder.decode((await reader.read()).value);
    await trigger();
    try {
      for (;;) {
        const match = buffer.match(new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`));
        if (match) return JSON.parse(match[1]);
        const { value, done } = await reader.read();
        assert.equal(done, false, 'the event stream ended early');
        buffer += decoder.decode(value);
      }
    } finally {
      await reader.cancel();
    }
  }

  test('serves the portal with security headers and refuses path traversal', async () => {
    const page = await fetch(origin + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(origin + '/%2e%2e/package.json')).status, 404);
    assert.equal((await fetch(origin + '/..%2fserver/main.js')).status, 404);
    assert.equal((await fetch(origin + '/.gitignore')).status, 404);
  });

  test('requires a session, a known Host and a same-origin Origin', async () => {
    assert.equal((await pat('GET', '/api/me')).status, 401);
    const crossOrigin = await fetch(origin + '/api/login', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(crossOrigin.status, 403);
    const noOrigin = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noOrigin.status, 403);
    // fetch refuses to send a custom Host, so the rebinding request is made with node:http.
    const rebound = await new Promise((resolve, reject) => {
      http.get(origin + '/api/me', { headers: { Host: 'evil.example' } }, (res) => resolve(res.resume().statusCode)).on('error', reject);
    });
    assert.equal(rebound, 421);
  });

  test('signs up, hashes the password, and sets hardened cookies', async () => {
    const empty = await pat('POST', '/api/signup', { json: { email: 'pat@example.com', password: '', givenName: 'Pat', familyName: 'Example' } });
    assert.equal(empty.status, 400);
    const created = await pat('POST', '/api/signup', {
      json: { email: 'Pat@Example.com', password: 'correct horse', givenName: 'Pat', familyName: 'Example' },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.patient, { email: 'pat@example.com', givenName: 'Pat', familyName: 'Example', deletionScheduledFor: '', connected: false });
    assert.equal(created.body.practice.name, 'Example Family Practice');
    for (const cookie of created.setCookies) assert.match(cookie, /HttpOnly; SameSite=Strict/);

    const file = path.join(dataDir, 'store.json');
    const saved = await readFile(file, 'utf8');
    assert.ok(!saved.includes('correct horse'));
    assert.match(JSON.parse(saved).patients[0].passwordHash, /^scrypt\$/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    const duplicate = await browser(origin)('POST', '/api/signup', {
      json: { email: 'pat@example.com', password: 'another password', givenName: 'P', familyName: 'E' },
    });
    assert.equal(duplicate.status, 409);
  });

  test('signs in with the right password only and throttles repeated failures', async () => {
    const other = browser(origin);
    assert.equal((await other('POST', '/api/login', { json: { email: 'pat@example.com', password: 'correct horse' } })).status, 200);
    assert.equal((await other('GET', '/api/me')).status, 200);
    assert.equal((await other('POST', '/api/logout')).status, 200);
    assert.equal((await other('GET', '/api/me')).status, 401);

    const attacker = browser(origin);
    for (let i = 0; i < 5; i++) {
      assert.equal((await attacker('POST', '/api/login', { json: { email: 'nobody@example.com', password: 'guess' } })).status, 401);
    }
    assert.equal((await attacker('POST', '/api/login', { json: { email: 'nobody@example.com', password: 'guess' } })).status, 429);
  });

  test('embeds the patient on first use and never returns the token', async () => {
    const connected = await pat('POST', '/api/messaging/connect');
    assert.equal(connected.status, 200);
    assert.equal(connected.body.patient.connected, true);
    assert.equal(store.patientByEmail('pat@example.com').practiceConversationId, 't_practice_entity_c1');
    assert.equal(connected.body.unreadConversationCount, 1);
    assert.equal(spruce.state.contacts.length, 1);
    assert.equal(spruce.state.contacts[0].category, 'patient');
    assert.equal(spruce.state.mints, 1);
    assert.ok(!JSON.stringify(connected.body).includes('tok_'));
    assert.ok(!(await readFile(path.join(dataDir, 'store.json'), 'utf8')).includes('tok_'));

    await pat('POST', '/api/messaging/connect');
    assert.equal(spruce.state.contacts.length, 1);
    assert.equal(spruce.state.mints, 1);
  });

  test('lists conversations and items', async () => {
    spruce.addItem('entity_c1', { authorId: 'entity_doc', authorDisplayName: 'Dr. So and So', text: 'How are you feeling today?' });
    const list = await pat('GET', '/api/conversations');
    assert.equal(list.body.conversations[0].id, 't_entity_c1');
    const items = await pat('GET', '/api/conversations/t_entity_c1/items?pageSize=200');
    assert.equal(items.body.items.length, 1);
    assert.equal(items.body.items[0].authorDisplayName, 'Dr. So and So');
    assert.equal((await pat('GET', '/api/conversations/t_entity_c1/items?pageSize=999')).status, 400);
    assert.equal((await pat('GET', '/api/conversations/bad%2Fid/items')).status, 400);
  });

  test('stores a rotated token and mints again once after a 401', async () => {
    spruce.state.rotateNext = true;
    assert.equal((await pat('GET', '/api/patient')).status, 200);
    assert.ok(spruce.state.tokens.has('rot_tok_1'));
    assert.equal((await pat('GET', '/api/patient')).status, 200);
    assert.equal(spruce.state.mints, 1, 'the rotated token was used, with no new mint');

    spruce.state.tokens.clear();
    assert.equal((await pat('GET', '/api/patient')).status, 200);
    assert.equal(spruce.state.mints, 2, 'a 401 led to exactly one new mint');
  });

  test('uploads media, posts with an idempotency key, and proxies the attachment', async () => {
    const upload = await pat('POST', '/api/media', {
      body: Buffer.from('PNGDATA'),
      headers: { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('my "photo".png') },
    });
    assert.equal(upload.status, 200);
    assert.match(spruce.state.uploads[0].contentType, /^multipart\/form-data/);
    assert.match(spruce.state.uploads[0].body, /name="media"; filename="my photo.png"/);
    assert.match(spruce.state.uploads[0].body, /Content-Type: image\/png/);

    const message = { text: 'Thanks, here is a photo.', attachments: [{ mediaId: upload.body.id }] };
    const noKey = await pat('POST', '/api/conversations/t_entity_c1/messages', { json: message });
    assert.equal(noKey.status, 400);
    const headers = { 'Idempotency-Key': 'b2f0c1de-0000-4000-8000-000000000001' };
    const posted = await pat('POST', '/api/conversations/t_entity_c1/messages', { json: message, headers });
    assert.equal(posted.status, 200);
    assert.equal(posted.body.message.text, 'Thanks, here is a photo.');
    const [attachment] = posted.body.message.attachments;
    assert.match(attachment.href, /^\/api\/attachments\/[\w-]+$/);
    const again = (await pat('GET', '/api/conversations/t_entity_c1/items')).body.items.find((item) => item.message?.attachments?.length);
    assert.equal(again?.message.attachments[0].href, attachment.href, 'a refetch keeps the attachment link');
    assert.equal(attachment.url, undefined, 'the signed URL stays on the server');
    const retried = await pat('POST', '/api/conversations/t_entity_c1/messages', { json: message, headers });
    assert.equal(retried.status, 422);

    const file = await pat('GET', attachment.href, { raw: true });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal(await file.text(), 'PNGDATA');

    const stranger = browser(origin);
    await stranger('POST', '/api/signup', { json: { email: 'sam@example.com', password: 'another password', givenName: 'Sam', familyName: 'Other' } });
    assert.equal((await stranger('GET', attachment.href)).status, 404, 'another patient cannot use the key');
    assert.equal((await pat('POST', '/api/conversations/t_entity_c1/messages', { json: {}, headers: { 'Idempotency-Key': 'another-key-1' } })).status, 400);
  });

  test('reads only a duplicate idempotency key as already sent, and any other refusal as a failure', async () => {
    const conversation = '/api/conversations/t_entity_c1';
    // The portal page's own api() function, pointed at the test browser.
    const api = async (method, pathname, options) => {
      const res = await pat(method, pathname, options);
      if (res.status >= 400) throw new ApiError(res.status, res.body.type, res.body.message);
      return res.body;
    };
    const entry = (key, files = []) => ({ key, text: 'Is this still on?', files: files.map((file) => ({ file })) });
    const count = () => spruce.state.items.length;
    const before = count();

    const first = entry('b2f0c1de-0000-4000-8000-00000000000a');
    assert.equal((await deliverMessage(first, conversation, api)).message.text, 'Is this still on?');
    assert.equal(await deliverMessage(first, conversation, api), null, 'a retry under the same key is already accepted');
    assert.equal(count(), before + 1, 'the retry posted nothing');

    spruce.state.rejectMessages = true;
    const refused = deliverMessage(entry('b2f0c1de-0000-4000-8000-00000000000b'), conversation, api);
    await assert.rejects(refused, (err) => err.status === 422 && err.type === 'unprocessable_entity');
    spruce.state.rejectMessages = false;
    assert.equal(count(), before + 1);

    spruce.state.rejectUploads = true;
    const withFile = entry('b2f0c1de-0000-4000-8000-00000000000c', [new File(['PNGDATA'], 'scan.png', { type: 'image/png' })]);
    await assert.rejects(deliverMessage(withFile, conversation, api), (err) => err.status === 422);
    assert.equal(count(), before + 1, 'a refused upload posts no message');
    assert.equal(withFile.files[0].mediaId, undefined);
    spruce.state.rejectUploads = false;
    // The key was never sent, so the retry of the same entry uploads the file and posts the message.
    assert.equal((await deliverMessage(withFile, conversation, api)).message.attachments.length, 1);
    assert.equal(count(), before + 2);
  });

  test('marks the conversation read', async () => {
    spruce.state.unread = true;
    const read = await pat('POST', '/api/conversations/t_entity_c1/read');
    assert.equal(read.status, 200);
    assert.equal(read.body.unread, false);
    assert.equal((await pat('GET', '/api/patient')).body.unreadConversationCount, 0);
  });

  test('updates the patient on the embed host and the portal record, leaving the practice contact alone', async () => {
    const details = { givenName: 'Patricia', familyName: 'Sample' };
    const saved = await pat('PATCH', '/api/account', { json: details });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.patient, { email: 'pat@example.com', ...details, deletionScheduledFor: '', connected: true });
    assert.deepEqual(spruce.state.patients.get('entity_c1'), details);
    const contact = spruce.state.contacts[0];
    assert.deepEqual([contact.givenName, contact.familyName], ['Pat', 'Example']);
    assert.equal(store.patientByEmail('pat@example.com').familyName, 'Sample');
    assert.equal((await pat('GET', '/api/me')).body.patient.givenName, 'Patricia');

    // Saving the same names again sends nothing to Spruce, which would post another note to the practice.
    assert.equal((await pat('PATCH', '/api/account', { json: details })).status, 200);
    assert.equal(spruce.state.patientUpdates, 1);

    for (const bad of [{ givenName: ' ' }, { familyName: '' }]) {
      assert.equal((await pat('PATCH', '/api/account', { json: { ...details, ...bad } })).status, 400);
    }
    assert.equal(store.patientByEmail('pat@example.com').givenName, 'Patricia');
  });

  test('refuses webhooks with a bad or missing signature', async () => {
    const event = { eventTime: new Date().toISOString(), object: 'event', type: 'embeddedPatientNotification.created', data: { object: {} } };
    assert.equal((await webhook(event, 'wrong-secret')).status, 401);
    const unsigned = await fetch(origin + '/webhooks/spruce', { method: 'POST', body: JSON.stringify(event) });
    assert.equal(unsigned.status, 401);
    assert.equal((await fetch(origin + '/webhooks/spruce')).status, 405);
  });

  test('relays a notification event to the patient it names', async () => {
    const object = {
      object: 'embeddedPatientNotification',
      patientOrganizationId: 'entity_p_entity_c1',
      conversationId: 't_entity_c1',
      itemId: 'ti_1',
      text: 'New message',
    };
    const received = await nextEvent(pat, 'notification', async () => {
      const unknown = await webhook({ eventTime: '', object: 'event', type: 'embeddedPatientNotification.created', data: { object: { ...object, patientOrganizationId: 'entity_nobody' } } });
      assert.equal(unknown.status, 200, 'events for unknown patients are acknowledged');
      const res = await webhook({ eventTime: new Date().toISOString(), object: 'event', type: 'embeddedPatientNotification.created', data: { object } });
      assert.equal(res.status, 200);
    });
    assert.deepEqual(received, { conversationId: 't_entity_c1', itemId: 'ti_1', text: 'New message' });
  });

  test('simulator delivers signed deleted and notification events through the webhook route', async () => {
    const state = await pat('GET', '/dev/api/state');
    const me = state.body.patients.find((patient) => patient.email === 'pat@example.com');
    assert.equal(me.online, true);
    const items = await pat('GET', `/dev/api/patients/${me.id}/items`);
    const target = items.body.items.find((item) => item.attachmentCount === 1);

    let sent;
    const item = await nextEvent(pat, 'item', async () => {
      sent = await pat('POST', '/dev/api/simulate', { json: { patientId: me.id, type: 'embeddedConversationItem.deleted', itemId: target.id } });
    });
    assert.equal(sent.body.status, 200);
    assert.equal(sent.body.event.type, 'embeddedConversationItem.deleted');
    assert.equal(item.item.id, target.id);
    assert.equal(item.item.deleted, true);
    assert.deepEqual(item.item.message, { text: '', attachments: [] });

    const restored = await pat('POST', '/dev/api/simulate', { json: { patientId: me.id, type: 'embeddedConversationItem.restored', itemId: target.id } });
    assert.equal(restored.body.event.data.object.deleted, false);
    assert.equal(restored.body.event.data.object.message.attachments[0].url, '[signed URL withheld]');

    const notified = await pat('POST', '/dev/api/simulate', { json: { patientId: me.id, type: 'embeddedPatientNotification.created', itemId: target.id } });
    assert.equal(notified.body.status, 200);
    assert.equal(notified.body.event.data.object.text, 'New message');
    assert.equal(spruce.state.mints, 2, 'the simulator borrowed a live token instead of minting');
  });

  test('fetches an attachment only from a Spruce host, whatever URL a webhook carried', async () => {
    const logged = logs.length;
    for (const [index, url] of ['https://attacker.example/secret', 'http://127.0.0.1:1/internal', 'http://169.254.169.254/latest/meta-data'].entries()) {
      const object = {
        object: 'embeddedConversationItem',
        id: `ti_forged_${index}`,
        conversationId: 't_entity_c1',
        patientOrganizationId: 'entity_p_entity_c1',
        type: 'message',
        deleted: false,
        message: { text: '', attachments: [{ type: 'image', name: 'x.png', mimeType: 'image/png', url, urlExpiresAt: new Date(Date.now() + 60000).toISOString() }] },
      };
      const event = await nextEvent(pat, 'item', () => webhook({ eventTime: '', object: 'event', type: 'embeddedConversationItem.restored', data: { object } }));
      assert.equal((await pat('GET', event.item.message.attachments[0].href)).status, 502);
    }
    assert.equal(logs.slice(logged).filter((line) => line.startsWith('attachment refused')).length, 3, 'each was refused before any request was made');
  });

  test('holds a redirected attachment to the same hosts', async () => {
    const spruceOrigin = new URL(spruce.apiUrl).origin;
    const fetchVia = async (id, target) => {
      const object = {
        object: 'embeddedConversationItem',
        id,
        conversationId: 't_entity_c1',
        patientOrganizationId: 'entity_p_entity_c1',
        type: 'message',
        deleted: false,
        message: {
          text: '',
          attachments: [{ type: 'image', name: 'x.png', mimeType: 'image/png', url: `${spruceOrigin}/redirect?to=${encodeURIComponent(target)}`, urlExpiresAt: new Date(Date.now() + 60000).toISOString() }],
        },
      };
      const event = await nextEvent(pat, 'item', () => webhook({ eventTime: '', object: 'event', type: 'embeddedConversationItem.restored', data: { object } }));
      return pat('GET', event.item.message.attachments[0].href, { raw: true });
    };
    const logged = logs.length;
    const outside = await fetchVia('ti_redirect_out', `${origin}/api/practice`);
    assert.equal(outside.status, 502);
    await outside.arrayBuffer();
    assert.equal(logs.slice(logged).filter((line) => line.startsWith('attachment refused')).length, 1);
    const inside = await fetchVia('ti_redirect_in', `${spruceOrigin}/media/m1`);
    assert.equal(inside.status, 200);
    assert.equal(await inside.text(), 'PNGDATA');
  });

  test('reports a clear error when Spruce Embedded Secure Messaging is not enabled', async () => {
    spruce.state.embedEnabled = false;
    const sam = browser(origin);
    await sam('POST', '/api/login', { json: { email: 'sam@example.com', password: 'another password' } });
    const refused = await sam('POST', '/api/messaging/connect');
    assert.equal(refused.status, 503);
    assert.equal(refused.body.type, 'embed_unavailable');
    spruce.state.embedEnabled = true;
  });

  test('pages backward from the newest item and refuses startFrom with a token', async () => {
    for (const text of ['one', 'two', 'three']) spruce.addItem('entity_c1', { authorId: 'entity_doc', authorDisplayName: 'Dr. So and So', text });
    const items = '/api/conversations/t_entity_c1/items';
    const all = (await pat('GET', `${items}?order=newest_first&pageSize=200`)).body.items.map((item) => item.id);
    const first = await pat('GET', `${items}?order=newest_first&pageSize=2`);
    assert.deepEqual(first.body.items.map((item) => item.id), all.slice(0, 2));
    assert.equal(first.body.hasMore, true);
    const paged = [...first.body.items];
    for (let page = first.body; page.hasMore; ) {
      page = (await pat('GET', `${items}?order=newest_first&pageSize=2&paginationToken=${page.paginationToken}`)).body;
      paged.push(...page.items);
    }
    assert.deepEqual(paged.map((item) => item.id), all);
    const mixed = await pat('GET', `${items}?startFrom=2026-01-01T00:00:00Z&paginationToken=${first.body.paginationToken}`);
    assert.equal(mixed.status, 400);
  });

  test('schedules the deletion with the practice credential, closes messaging, and cancels by contact', async () => {
    const scheduled = await pat('POST', '/api/account/deletion');
    assert.equal(scheduled.status, 200);
    assert.equal(scheduled.body.patient.deletionScheduledFor, '2099-01-01T00:00:00Z');
    assert.deepEqual(store.patientByEmail('pat@example.com').deletion, { scheduledFor: '2099-01-01T00:00:00Z' });
    assert.equal(spruce.state.deletions.size, 1);
    assert.equal(spruce.state.tokens.size, 0, 'Spruce revoked every token of the patient');

    const mints = spruce.state.mints;
    const closed = await pat('GET', '/api/conversations');
    assert.equal(closed.status, 409);
    assert.equal(closed.body.type, 'deletion_pending');
    assert.equal(spruce.state.mints, mints, 'no mint is attempted while the deletion is pending');
    assert.equal((await pat('PATCH', '/api/account', { json: { givenName: 'Pat', familyName: 'Example' } })).status, 409);
    assert.equal((await pat('POST', '/api/account/deletion')).body.patient.deletionScheduledFor, '2099-01-01T00:00:00Z');

    spruce.state.deletionRunning = true;
    const late = await pat('POST', '/api/account/deletion/cancel');
    assert.equal(late.status, 409);
    assert.equal(late.body.type, 'deletion_running');
    spruce.state.deletionRunning = false;

    const cancelled = await pat('POST', '/api/account/deletion/cancel');
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.patient.deletionScheduledFor, '');
    assert.equal(spruce.state.deletions.size, 0);
    assert.equal(store.patientByEmail('pat@example.com').deletion, null);
    assert.equal((await pat('POST', '/api/account/deletion/cancel')).status, 200, 'cancelling again is harmless');
    assert.equal((await pat('GET', '/api/conversations')).status, 200);
    assert.equal(spruce.state.mints, mints + 1);
  });

  test('removes the portal record once the scheduled time has passed', async () => {
    const lee = browser(origin);
    await lee('POST', '/api/signup', { json: { email: 'lee@example.com', givenName: 'Lee', familyName: 'Example', password: '12345' } });
    const scheduled = await lee('POST', '/api/account/deletion');
    assert.ok(Date.parse(scheduled.body.patient.deletionScheduledFor) > Date.now() + 29 * 24 * 60 * 60 * 1000);
    assert.equal((await lee('GET', '/api/me')).status, 200);

    const record = store.patientByEmail('lee@example.com');
    await store.updatePatient(record.id, { deletion: { ...record.deletion, scheduledFor: '2020-01-01T00:00:00Z' } });
    assert.equal((await lee('GET', '/api/me')).status, 401);
    assert.equal(store.patientByEmail('lee@example.com'), null);
    assert.equal((await lee('POST', '/api/login', { json: { email: 'lee@example.com', password: '12345' } })).status, 401);
  });

  test('revokes the device token on Spruce at sign out, and signs out even when Spruce fails', async () => {
    const other = browser(origin);
    const login = { json: { email: 'pat@example.com', password: 'correct horse' } };
    assert.equal((await other('POST', '/api/login', login)).status, 200);
    assert.equal((await other('GET', '/api/patient')).status, 200);
    const held = spruce.state.tokens.size;
    const logouts = spruce.state.logouts;
    assert.equal((await other('POST', '/api/logout')).status, 200);
    assert.equal(spruce.state.logouts, logouts + 1);
    assert.equal(spruce.state.tokens.size, held - 1, 'only the signed-out device lost its token');
    assert.equal((await other('GET', '/api/me')).status, 401);
    assert.equal((await pat('GET', '/api/patient')).status, 200, 'the other browser keeps its session and token');

    // A browser that never opened messaging holds no token, so nothing is sent to Spruce.
    assert.equal((await other('POST', '/api/login', login)).status, 200);
    assert.equal((await other('POST', '/api/logout')).status, 200);
    assert.equal(spruce.state.logouts, logouts + 1);

    assert.equal((await other('POST', '/api/login', login)).status, 200);
    assert.equal((await other('GET', '/api/patient')).status, 200);
    spruce.state.logoutFails = true;
    assert.equal((await other('POST', '/api/logout')).status, 200);
    spruce.state.logoutFails = false;
    assert.equal((await other('GET', '/api/me')).status, 401);
  });

  test('signing out one browser leaves the event stream of another open', async () => {
    const other = browser(origin);
    assert.equal((await other('POST', '/api/login', { json: { email: 'pat@example.com', password: 'correct horse' } })).status, 200);
    const object = { patientOrganizationId: 'entity_p_entity_c1', conversationId: 't_entity_c1', itemId: 'ti_1', text: 'New message' };
    const received = await nextEvent(pat, 'notification', async () => {
      assert.equal((await other('POST', '/api/logout')).status, 200);
      await webhook({ eventTime: '', object: 'event', type: 'embeddedPatientNotification.created', data: { object } });
    });
    assert.equal(received.itemId, 'ti_1');
  });

  test('revokes the device token on Spruce when the portal session expires', async () => {
    const other = browser(origin);
    assert.equal((await other('POST', '/api/login', { json: { email: 'pat@example.com', password: 'correct horse' } })).status, 200);
    assert.equal((await other('GET', '/api/patient')).status, 200);
    assert.equal((await pat('GET', '/api/patient')).status, 200);
    const held = spruce.state.tokens.size;
    const logouts = spruce.state.logouts;

    // A second sign-in from the same browser shares the device's token, which must outlive the first session.
    clockSkewMs = 6 * 60 * 60 * 1000;
    assert.equal((await other('POST', '/api/login', { json: { email: 'pat@example.com', password: 'correct horse' } })).status, 200);
    clockSkewMs = 13 * 60 * 60 * 1000;
    await app.sweepSessions();
    assert.equal(spruce.state.logouts, logouts + 1, 'only the browser with no live session lost its token');
    assert.equal(spruce.state.tokens.size, held - 1);
    assert.equal((await pat('GET', '/api/me')).status, 401);
    const mints = spruce.state.mints;
    assert.equal((await other('GET', '/api/patient')).status, 200);
    assert.equal(spruce.state.mints, mints, 'the newer session still uses the token it shares');

    clockSkewMs = 19 * 60 * 60 * 1000;
    await app.sweepSessions();
    assert.equal(spruce.state.logouts, logouts + 2);
    assert.equal(spruce.state.tokens.size, held - 2);
    clockSkewMs = 0;
  });

  test('never logs credentials or tokens', () => {
    const all = logs.join('\n');
    assert.ok(!all.includes(spruce.state.credential));
    assert.ok(!all.includes('tok_'));
    assert.ok(!all.includes(WEBHOOK_SECRET));
  });
});

test('a store that cannot save the contact id does not create a second Spruce contact', async () => {
  const spruce = await startFakeSpruce();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'embed-sample-'));
  const practice = createPracticeClient({ baseUrl: spruce.apiUrl, credential: spruce.state.credential });
  const app = createApp({
    config: { apiUrl: spruce.apiUrl, embedUrl: spruce.embedUrl, webhookSecret: WEBHOOK_SECRET },
    store: await openStore(dataDir),
    practice,
    organization: await practice.organization(),
    internalEndpointId: 'link_1',
    log: () => {},
  });
  await app.listen(0);
  try {
    const pat = browser(app.origin());
    await pat('POST', '/api/signup', { json: { email: 'pat@example.com', password: 'correct horse', givenName: 'Pat', familyName: 'Example' } });
    // A directory where the temporary file belongs makes every write fail until it is removed.
    await mkdir(path.join(dataDir, 'store.json.tmp'));
    assert.equal((await pat('POST', '/api/messaging/connect')).status, 500);
    assert.equal((await pat('POST', '/api/messaging/connect')).status, 500);
    assert.equal(spruce.state.contacts.length, 1);
    await rmdir(path.join(dataDir, 'store.json.tmp'));
    assert.equal((await pat('POST', '/api/messaging/connect')).status, 200);
    assert.equal(spruce.state.contacts.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(dataDir, 'store.json'), 'utf8')).patients[0].contactId, 'entity_c1');
  } finally {
    await app.close();
    await spruce.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('refuses messaging to a patient whose identity is not verified, and creates or embeds nothing at Spruce', async () => {
  const spruce = await startFakeSpruce();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'embed-sample-'));
  const store = await openStore(dataDir);
  const practice = createPracticeClient({ baseUrl: spruce.apiUrl, credential: spruce.state.credential });
  const logs = [];
  const app = createApp({
    config: { apiUrl: spruce.apiUrl, embedUrl: spruce.embedUrl, webhookSecret: WEBHOOK_SECRET },
    store,
    practice,
    organization: await practice.organization(),
    internalEndpointId: 'link_1',
    log: (line) => logs.push(line),
  });
  await app.listen(0);
  try {
    const passwordHash = await hashPassword('correct horse');
    const blank = { passwordHash, contactId: '', patientOrganizationId: '', practiceConversationId: '' };
    // One record says unverified outright; the others predate the field, one of them already holding a contact from before.
    await store.createPatient({ ...blank, email: 'unverified@example.com', givenName: 'Una', familyName: 'Verified', identityVerified: false });
    await store.createPatient({ ...blank, email: 'legacy@example.com', givenName: 'Leg', familyName: 'Acy' });
    await store.createPatient({ ...blank, email: 'embedded@example.com', givenName: 'Em', familyName: 'Bedded', contactId: 'entity_old' });

    for (const email of ['unverified@example.com', 'legacy@example.com', 'embedded@example.com']) {
      const client = browser(app.origin());
      assert.equal((await client('POST', '/api/login', { json: { email, password: 'correct horse' } })).status, 200);
      for (const [method, pathname] of [
        ['POST', '/api/messaging/connect'],
        ['GET', '/api/patient'],
        ['GET', '/api/conversations'],
      ]) {
        const refused = await client(method, pathname);
        assert.equal(refused.status, 403, `${email} ${pathname}`);
        assert.deepEqual(refused.body, {
          statusCode: 403,
          type: 'identity_unverified',
          message: 'Messaging is not available until your identity has been verified.',
        });
      }
      assert.equal(store.patientByEmail(email).patientOrganizationId, '');
    }
    assert.equal(spruce.state.contacts.length, 0);
    assert.equal(spruce.state.embedded.size, 0);
    assert.equal(spruce.state.mints, 0);
    assert.ok(logs.some((line) => line.includes('not marked identityVerified')));

    // A patient who signs up is marked verified by the sample's placeholder and connects as before.
    const pat = browser(app.origin());
    await pat('POST', '/api/signup', { json: { email: 'pat@example.com', password: 'correct horse', givenName: 'Pat', familyName: 'Example' } });
    assert.equal(store.patientByEmail('pat@example.com').identityVerified, true);
    const connected = await pat('POST', '/api/messaging/connect');
    assert.equal(connected.status, 200);
    assert.equal(connected.body.patient.connected, true);
    assert.equal(spruce.state.contacts.length, 1);
    assert.equal(spruce.state.contacts[0].givenName, 'Pat');
    assert.equal(spruce.state.mints, 1);
  } finally {
    await app.close();
    await spruce.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

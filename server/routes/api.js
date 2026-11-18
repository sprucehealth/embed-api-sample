import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { hashPassword, verifyPassword } from '../auth.js';
import { HttpError, readBody, readJson, sendJson } from '../http.js';
import { SpruceError } from '../spruce/request.js';
import { EmailTakenError } from '../store.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const MIME_TYPE = /^[\w.+-]{1,100}\/[\w.+-]{1,100}$/;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_LENGTH = 10000;
const MAX_ATTACHMENTS = 5;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

function requireId(value, name) {
  if (!ID.test(value ?? '')) throw new HttpError(400, 'invalid_input', `Invalid ${name}.`);
  return value;
}

function requireName(value, label) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > 80) throw new HttpError(400, 'invalid_input', `${label} is required.`);
  return name;
}

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email)) throw new HttpError(400, 'invalid_input', 'Enter a valid email address.');
  return email;
}

function fileName(header) {
  let name = '';
  try {
    name = decodeURIComponent(String(header ?? ''));
  } catch {
    name = '';
  }
  // Path separators, quotes and control characters are dropped so the name is safe inside a multipart header.
  name = name.replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim().slice(0, 200);
  return name || 'attachment';
}

export function registerApiRoutes(router, deps) {
  const { store, organization, throttle, hub, attachments, gateway, practiceClient, fetchImpl, isMediaUrl, startSession, endSession, stillExists, log } = deps;
  const auth = { auth: true };
  const practice = { name: organization.name };
  let dummyHash;

  const view = (patient) => ({
    email: patient.email,
    givenName: patient.givenName,
    familyName: patient.familyName,
    deletionScheduledFor: patient.deletion?.scheduledFor ?? '',
    connected: Boolean(patient.patientOrganizationId),
  });

  // Only a Spruce host is ever fetched, whatever URL an item or a webhook payload carried.
  // Redirects are followed by hand so that each one is held to the same rule.
  async function fetchMedia(raw, signal) {
    let url = raw;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isMediaUrl(url)) {
        log('attachment refused: its URL is not on a Spruce host (see SPRUCE_MEDIA_HOSTS)');
        throw new HttpError(502, 'upstream_error', 'Unavailable.');
      }
      const res = await fetchImpl(url, { signal, redirect: 'manual' });
      const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null;
      if (!location) return res;
      await res.arrayBuffer().catch(() => {});
      url = new URL(location, url).href;
    }
    throw new HttpError(502, 'upstream_error', 'Unavailable.');
  }

  router.add('POST', '/api/signup', async (ctx) => {
    const body = await readJson(ctx.req);
    const email = normalizeEmail(body.email);
    const givenName = requireName(body.givenName, 'First name');
    const familyName = requireName(body.familyName, 'Last name');
    const password = typeof body.password === 'string' ? body.password : '';
    // The sample sets no password rules beyond a password being present; the upper bound only caps the hashing work.
    if (password.length < 1 || password.length > 200) throw new HttpError(400, 'invalid_input', 'Enter a password.');
    if (store.patientByEmail(email)) throw new HttpError(409, 'email_taken', 'An account with this email already exists.');
    const passwordHash = await hashPassword(password);
    // ---------------------------------------------------------------------------------------------------------------
    // PLACEHOLDER: the sample marks every new account as identity verified, so it runs end to end without extra setup.
    // A real integration must not copy this line as it is. Messaging creates a Spruce contact under the name and email
    // typed here and gives it a secure conversation in the practice's inbox, so setting identityVerified without
    // verifying anything lets anyone message the practice as anyone. Set it only once the portal has verified the
    // patient: at minimum a confirmed email address or phone number, or the identity proofing the portal already does.
    // The gate that reads it is in mint() in server/app.js. See SECURITY.md, "Verified patient identity".
    // ---------------------------------------------------------------------------------------------------------------
    const identityVerified = true;
    // The store checks the email again as it saves, which covers a sign-up that landed during the slow hash.
    const patient = await store
      .createPatient({
        email,
        passwordHash,
        givenName,
        familyName,
        identityVerified,
        contactId: '',
        patientOrganizationId: '',
        practiceConversationId: '',
      })
      .catch((err) => {
        if (err instanceof EmailTakenError) throw new HttpError(409, 'email_taken', 'An account with this email already exists.');
        throw err;
      });
    startSession(ctx, patient);
    sendJson(ctx.res, 201, { patient: view(patient), practice });
  });

  router.add('POST', '/api/login', async (ctx) => {
    const body = await readJson(ctx.req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const key = `${email}|${ctx.req.socket.remoteAddress}`;
    if (throttle.blocked(key)) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again in a few minutes.');
    // The attempt is counted before the slow password check, so attempts sent together cannot all pass the limit.
    throttle.fail(key);
    const patient = store.patientByEmail(email);
    // An unknown email is checked against a dummy hash so both failures take the same time.
    dummyHash ??= await hashPassword('not a real password');
    const ok = await verifyPassword(password, patient?.passwordHash ?? dummyHash);
    if (!ok || !(await stillExists(patient))) throw new HttpError(401, 'bad_credentials', 'The email or password is incorrect.');
    throttle.clear(key);
    startSession(ctx, patient);
    sendJson(ctx.res, 200, { patient: view(patient), practice });
  });

  router.add(
    'POST',
    '/api/logout',
    async (ctx) => {
      // The portal session ends even when Spruce cannot be reached; the token is dropped either way and expires on its own.
      await gateway.logout(ctx.actor).catch((err) => log(`revoking the Spruce token at sign out failed: ${err.status ?? err.name}`));
      endSession(ctx);
      sendJson(ctx.res, 200, {});
    },
    auth,
  );

  // The practice name is public, so the sign-in screen can show whose portal this is.
  router.add('GET', '/api/practice', async (ctx) => sendJson(ctx.res, 200, practice));

  router.add('GET', '/api/me', async (ctx) => sendJson(ctx.res, 200, { patient: view(ctx.patient), practice }), auth);

  router.add(
    'PATCH',
    '/api/account',
    async (ctx) => {
      const body = await readJson(ctx.req);
      if (ctx.patient.deletion) throw new HttpError(409, 'deletion_pending', 'Details cannot be changed while a deletion is pending.');
      const details = {
        givenName: requireName(body.givenName, 'First name'),
        familyName: requireName(body.familyName, 'Last name'),
      };
      const changed = details.givenName !== ctx.patient.givenName || details.familyName !== ctx.patient.familyName;
      // Spruce posts a note to the practice for every update, so the request is sent only when a name changed.
      if (changed && ctx.patient.patientOrganizationId) await gateway.call(ctx.actor, 'PATCH', '/patient', { json: details });
      // The portal's record is saved last, so a failed Spruce call leaves it unchanged and the patient can save again.
      sendJson(ctx.res, 200, { patient: view(await store.updatePatient(ctx.patient.id, details)) });
    },
    auth,
  );

  router.add(
    'POST',
    '/api/account/deletion',
    async (ctx) => {
      let patient = ctx.patient;
      if (!patient.deletion) {
        // A patient who never opened messaging has no Spruce data, so only the portal's own grace period applies.
        let deletion = { scheduledFor: new Date(Date.now() + GRACE_PERIOD_MS).toISOString() };
        if (patient.patientOrganizationId) {
          // The practice schedules the deletion with its own credential. A patient token cannot, and there is no cancellation token to keep.
          const scheduled = await practiceClient.scheduleDeletion(patient.contactId);
          if (Number.isNaN(Date.parse(scheduled.scheduledDeletionTime))) throw new HttpError(502, 'upstream_error', 'Spruce did not return a deletion date.');
          deletion = { scheduledFor: scheduled.scheduledDeletionTime };
        }
        patient = await store.updatePatient(patient.id, { deletion });
        gateway.forgetPatient(patient.id);
      }
      sendJson(ctx.res, 200, { patient: view(patient) });
    },
    auth,
  );

  router.add(
    'POST',
    '/api/account/deletion/cancel',
    async (ctx) => {
      let patient = ctx.patient;
      if (patient.deletion) {
        if (patient.patientOrganizationId) {
          try {
            // The practice credential cancels by contact, and the call succeeds when nothing is pending.
            await practiceClient.cancelDeletion(patient.contactId);
          } catch (err) {
            if (err instanceof SpruceError && err.status === 409) {
              throw new HttpError(409, 'deletion_running', 'The deletion has started and can no longer be cancelled.');
            }
            throw err;
          }
        }
        patient = await store.updatePatient(patient.id, { deletion: null });
      }
      sendJson(ctx.res, 200, { patient: view(patient) });
    },
    auth,
  );

  // The first embed host call for a patient creates the contact, embeds it and mints the token behind the scenes.
  router.add(
    'POST',
    '/api/messaging/connect',
    async (ctx) => {
      const embedded = await gateway.call(ctx.actor, 'GET', '/patient');
      const patient = store.patientById(ctx.patient.id);
      sendJson(ctx.res, 200, {
        patient: view(patient),
        unreadConversationCount: embedded.unreadConversationCount,
      });
    },
    auth,
  );

  router.add(
    'GET',
    '/api/patient',
    async (ctx) => {
      const embedded = await gateway.call(ctx.actor, 'GET', '/patient');
      sendJson(ctx.res, 200, { unreadConversationCount: embedded.unreadConversationCount });
    },
    auth,
  );

  router.add(
    'GET',
    '/api/conversations',
    async (ctx) => sendJson(ctx.res, 200, await gateway.call(ctx.actor, 'GET', '/conversations')),
    auth,
  );

  router.add(
    'GET',
    '/api/conversations/:conversationId',
    async (ctx) => {
      const id = requireId(ctx.params.conversationId, 'conversation id');
      sendJson(ctx.res, 200, await gateway.call(ctx.actor, 'GET', `/conversations/${id}`));
    },
    auth,
  );

  router.add(
    'GET',
    '/api/conversations/:conversationId/items',
    async (ctx) => {
      const id = requireId(ctx.params.conversationId, 'conversation id');
      const params = ctx.url.searchParams;
      const query = {};
      const pageSize = params.get('pageSize');
      if (pageSize !== null) {
        if (!/^\d{1,3}$/.test(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 200) {
          throw new HttpError(400, 'invalid_input', 'Invalid pageSize.');
        }
        query.pageSize = pageSize;
      }
      const order = params.get('order');
      if (order !== null) {
        if (order !== 'oldest_first' && order !== 'newest_first') throw new HttpError(400, 'invalid_input', 'Invalid order.');
        query.order = order;
      }
      const startFrom = params.get('startFrom');
      if (startFrom !== null) {
        if (Number.isNaN(Date.parse(startFrom))) throw new HttpError(400, 'invalid_input', 'Invalid startFrom.');
        query.startFrom = startFrom;
      }
      const paginationToken = params.get('paginationToken');
      if (paginationToken !== null) {
        if (paginationToken.length > 500) throw new HttpError(400, 'invalid_input', 'Invalid paginationToken.');
        query.paginationToken = paginationToken;
      }
      const page = await gateway.call(ctx.actor, 'GET', `/conversations/${id}/items`, { query });
      sendJson(ctx.res, 200, {
        items: page.items.map((item) => attachments.sanitizeItem(ctx.patient.id, item)),
        hasMore: page.hasMore,
        paginationToken: page.paginationToken ?? '',
      });
    },
    auth,
  );

  router.add(
    'POST',
    '/api/conversations/:conversationId/messages',
    async (ctx) => {
      const id = requireId(ctx.params.conversationId, 'conversation id');
      const key = ctx.req.headers['idempotency-key'];
      if (!IDEMPOTENCY_KEY.test(key ?? '')) throw new HttpError(400, 'invalid_input', 'Send an Idempotency-Key header.');
      const body = await readJson(ctx.req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text.length > MAX_TEXT_LENGTH) throw new HttpError(400, 'invalid_input', 'The message is too long.');
      const list = Array.isArray(body.attachments) ? body.attachments : [];
      if (list.length > MAX_ATTACHMENTS) throw new HttpError(400, 'invalid_input', `Attach at most ${MAX_ATTACHMENTS} files.`);
      const message = { attachments: list.map((a) => ({ mediaId: requireId(a?.mediaId, 'media id') })) };
      if (text) message.text = text;
      if (!text && message.attachments.length === 0) throw new HttpError(400, 'invalid_input', 'Write a message or attach a file.');
      // The browser's key is forwarded unchanged, so a retry of the same send is refused by Spruce instead of posted twice.
      const item = await gateway.call(ctx.actor, 'POST', `/conversations/${id}/messages`, {
        json: message,
        headers: { 'S-Idempotency-Key': key },
      });
      sendJson(ctx.res, 200, attachments.sanitizeItem(ctx.patient.id, item));
    },
    auth,
  );

  router.add(
    'POST',
    '/api/conversations/:conversationId/read',
    async (ctx) => {
      const id = requireId(ctx.params.conversationId, 'conversation id');
      sendJson(ctx.res, 200, await gateway.call(ctx.actor, 'POST', `/conversations/${id}/read`));
    },
    auth,
  );

  // The browser sends the raw file; the multipart "media" field Spruce expects is built here.
  router.add(
    'POST',
    '/api/media',
    async (ctx) => {
      const type = String(ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!MIME_TYPE.test(type)) throw new HttpError(400, 'invalid_input', 'Send the file with its Content-Type.');
      const name = fileName(ctx.req.headers['x-file-name']);
      const bytes = await readBody(ctx.req, MAX_UPLOAD_BYTES);
      if (bytes.length === 0) throw new HttpError(400, 'invalid_input', 'The file is empty.');
      const media = await gateway.call(ctx.actor, 'POST', '/media', {
        form: () => {
          const form = new FormData();
          form.append('media', new Blob([bytes], { type }), name);
          return form;
        },
      });
      sendJson(ctx.res, 200, { id: media.id });
    },
    auth,
  );

  // Streams an attachment by its opaque key, so the browser never holds a signed URL and the server never fetches a URL the browser chose.
  router.add(
    'GET',
    '/api/attachments/:key',
    async (ctx) => {
      const record = attachments.get(ctx.params.key);
      if (!record || record.patientId !== ctx.patient.id) throw new HttpError(404, 'not_found', 'Not found.');
      if (!(record.expiresAt > Date.now())) throw new HttpError(410, 'expired', 'This link expired. Reload the conversation.');
      // The timeout covers the wait for the response headers only, so a large file on a slow connection is not cut off.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      const upstream = await fetchMedia(record.url, controller.signal).finally(() => clearTimeout(timer));
      if (!upstream.ok || !upstream.body) {
        await upstream.arrayBuffer().catch(() => {});
        throw new HttpError(upstream.status === 403 ? 410 : 502, 'unavailable', 'The attachment could not be fetched.');
      }
      const inline = INLINE_IMAGE_TYPES.has(record.mimeType);
      const headers = {
        'Content-Type': inline ? record.mimeType : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(record.name || 'attachment')}`,
        'Cache-Control': 'private, no-store',
      };
      const length = upstream.headers.get('content-length');
      // A compressed response is decoded while it is read, so its declared length does not describe the bytes sent on.
      if (length && !upstream.headers.get('content-encoding')) headers['Content-Length'] = length;
      ctx.res.writeHead(200, headers);
      await pipeline(Readable.fromWeb(upstream.body), ctx.res);
    },
    auth,
  );

  router.add('GET', '/api/events', async (ctx) => hub.subscribe(ctx.patient.id, ctx.req, ctx.res, { sessionId: ctx.session.id, until: ctx.session.expiresAt }), auth);
}

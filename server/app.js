import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAttachmentRegistry, createMediaHostCheck } from './attachments.js';
import { createSessions, createThrottle, newDeviceId } from './auth.js';
import { createEventHub } from './events.js';
import {
  HttpError,
  appendCookie,
  createRouter,
  parseCookies,
  readBody,
  sendError,
  sendJson,
  serveStatic,
  setSecurityHeaders,
} from './http.js';
import { registerApiRoutes } from './routes/api.js';
import { registerDevRoutes } from './routes/dev.js';
import { createSimulator } from './simulator.js';
import { createEmbedGateway } from './spruce/embed.js';
import { SpruceError } from './spruce/request.js';
import { createWebhookHandler, verifySignature } from './webhooks.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const WEBHOOK_PATH = '/webhooks/spruce';
const SESSION_COOKIE = 'eas_session';
const DEVICE_COOKIE = 'eas_device';
const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const DELETION_PENDING = 'Messaging is closed for this account while a deletion is pending.';
const IDENTITY_UNVERIFIED = 'Messaging is not available until your identity has been verified.';
const SWEEP_MS = 60 * 1000;
const SHUTDOWN_REVOKE_MS = 5000;
const PASS_THROUGH_STATUSES = new Set([400, 404, 409, 422, 429]);

// Turns any thrown value into an error that is safe to show the browser, logging the detail that is not.
function toHttpError(err, log) {
  if (err instanceof HttpError) return err;
  if (err instanceof SpruceError) {
    log(`spruce ${err.host} answered ${err.status} ${err.type} (request ${err.requestId || 'unknown'})`);
    if (PASS_THROUGH_STATUSES.has(err.status)) return new HttpError(err.status, err.type, err.message);
    return new HttpError(502, 'upstream_error', 'The messaging service could not complete the request.');
  }
  if (err?.name === 'TimeoutError' || err?.message === 'fetch failed') {
    log(`spruce request failed: ${err.name}`);
    return new HttpError(502, 'upstream_unreachable', 'The messaging service did not answer.');
  }
  log(`unexpected error: ${err?.stack ?? err}`);
  return new HttpError(500, 'internal', 'Something went wrong.');
}

export function createApp({ config, store, practice, organization, internalEndpointId, fetchImpl = fetch, log = console.log, now = Date.now }) {
  const sessions = createSessions({ now, onExpire: releaseSession });
  const throttle = createThrottle();
  const hub = createEventHub();
  const attachments = createAttachmentRegistry();
  const router = createRouter();
  const server = http.createServer(handle);
  const origin = () => `http://127.0.0.1:${server.address().port}`;

  const chains = new Map();
  // Runs one task at a time per patient, so two tabs opening messaging together cannot create two contacts.
  function withPatientLock(patientId, task) {
    const next = (chains.get(patientId) ?? Promise.resolve()).catch(() => {}).then(task);
    chains.set(patientId, next);
    next.catch(() => {}).finally(() => {
      if (chains.get(patientId) === next) chains.delete(patientId);
    });
    return next;
  }

  const unsavedContacts = new Map();
  // Creates the Spruce contact on first use, then embeds it and mints a token for the device.
  function mint(patientId, deviceId) {
    return withPatientLock(patientId, async () => {
      let patient = store.patientById(patientId);
      // Spruce shows the practice whatever name and email this call sends, so no contact is created or embedded for a patient
      // the portal has not verified. Only an explicit true passes: a record without the field, such as one saved before the
      // field existed, is treated as unverified and refused, never grandfathered in. See SECURITY.md, "Verified patient identity".
      if (patient.identityVerified !== true) {
        log('messaging refused: the patient record is not marked identityVerified (see SECURITY.md)');
        throw new HttpError(403, 'identity_unverified', IDENTITY_UNVERIFIED);
      }
      // Spruce refuses to embed a patient whose deletion is pending, so the call is not made.
      if (patient.deletion) throw new HttpError(409, 'deletion_pending', DELETION_PENDING);
      if (!patient.contactId) {
        // A contact whose id could not be saved is used again on the next attempt, so a failing store never creates a second one.
        let contactId = unsavedContacts.get(patientId);
        if (!contactId) {
          const contact = await practice.createContact({
            givenName: patient.givenName,
            familyName: patient.familyName,
            emailAddress: patient.email,
          });
          contactId = contact.id;
          unsavedContacts.set(patientId, contactId);
        }
        patient = await store.updatePatient(patientId, { contactId });
        unsavedContacts.delete(patientId);
      }
      let result;
      try {
        result = await practice.embedContact(patient.contactId, { deviceId, internalEndpointId });
      } catch (err) {
        if (err instanceof SpruceError && err.status === 404) {
          log(`embed answered 404 (request ${err.requestId || 'unknown'})`);
          throw new HttpError(503, 'embed_unavailable', 'Messaging is not available: Spruce Embedded Secure Messaging is not enabled for this organization.');
        }
        if (err instanceof SpruceError && err.status === 409) {
          throw new HttpError(409, 'deletion_pending', DELETION_PENDING);
        }
        throw err;
      }
      await store.updatePatient(patientId, {
        patientOrganizationId: result.embed.patientOrganizationId,
        // This is the practice's copy of the conversation, for Public API calls; the patient's copy has its own id on the embed host.
        practiceConversationId: result.embed.conversationId,
      });
      return result.embed.token;
    });
  }

  const gateway = createEmbedGateway({ baseUrl: config.embedUrl, mint, fetchImpl });
  const handleWebhook = createWebhookHandler({ store, hub, attachments, log });
  const simulator = createSimulator({
    store,
    gateway,
    secret: config.webhookSecret,
    webhookUrl: () => origin() + WEBHOOK_PATH,
    fetchImpl,
  });

  // Removes the portal's own record once the scheduled deletion time has passed, and reports whether the patient still exists.
  async function stillExists(patient) {
    // A deletion time that cannot be read is treated as not yet due, so a bad value never removes an account.
    if (!patient?.deletion || !(Date.parse(patient.deletion.scheduledFor) <= Date.now())) return Boolean(patient);
    gateway.forgetPatient(patient.id);
    hub.closePatient(patient.id);
    await store.deletePatient(patient.id);
    return false;
  }

  function startSession(ctx, patient) {
    appendCookie(ctx.res, SESSION_COOKIE, sessions.create(patient.id, ensureDevice(ctx)), { maxAgeSeconds: 12 * 60 * 60 });
  }

  // A session that runs out ends like one that is signed out: its event streams close and its device's Spruce token is revoked.
  async function releaseSession(session) {
    hub.closeSession(session.patientId, session.id);
    // A newer session in the same browser shares the device's token, so the token is left for it.
    if (sessions.usesDevice(session.patientId, session.deviceId)) return;
    await gateway
      .logout({ patientId: session.patientId, deviceId: session.deviceId })
      .catch((err) => log(`revoking the Spruce token of an expired session failed: ${err.status ?? err.name}`));
  }

  const sweepSessions = () => Promise.all(sessions.sweep());
  // Most patients never press Sign out, so expired sessions are swept on a timer and not only when someone signs in.
  const sweeper = setInterval(sweepSessions, SWEEP_MS);
  sweeper.unref();

  // The device id names this browser to Spruce; it outlives the session so a later mint replaces this browser's token.
  function ensureDevice(ctx) {
    if (!DEVICE_ID.test(ctx.cookies[DEVICE_COOKIE] ?? '')) {
      ctx.cookies[DEVICE_COOKIE] = newDeviceId();
      appendCookie(ctx.res, DEVICE_COOKIE, ctx.cookies[DEVICE_COOKIE], { maxAgeSeconds: 365 * 24 * 60 * 60 });
    }
    return ctx.cookies[DEVICE_COOKIE];
  }

  function endSession(ctx) {
    sessions.destroy(ctx.cookies[SESSION_COOKIE]);
    // Only this session's streams end; the patient's other browsers stay connected.
    if (ctx.session) hub.closeSession(ctx.session.patientId, ctx.session.id);
    appendCookie(ctx.res, SESSION_COOKIE, '', { maxAgeSeconds: 0 });
  }

  const deps = {
    store,
    organization,
    throttle,
    hub,
    attachments,
    gateway,
    practiceClient: practice,
    simulator,
    fetchImpl,
    isMediaUrl: createMediaHostCheck(config),
    startSession,
    endSession,
    stillExists,
    log,
  };
  registerApiRoutes(router, deps);
  registerDevRoutes(router, deps);

  async function receiveWebhook(req, res) {
    const raw = await readBody(req, 1024 * 1024);
    if (!verifySignature(config.webhookSecret, raw, req.headers['x-spruce-signature'])) {
      throw new HttpError(401, 'bad_signature', 'The signature does not match the payload.');
    }
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_input', 'The payload is not JSON.');
    }
    // Handling only fans out in memory, so it runs before the 2XX; slower work belongs on a queue after the acknowledgement.
    handleWebhook(event);
    sendJson(res, 200, { received: true });
  }

  function checkBrowserRequest(req) {
    const port = server.address().port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    // Refusing unknown Host values stops a hostile site from reaching the loopback server through DNS rebinding.
    if (!hosts.has(req.headers.host)) throw new HttpError(421, 'bad_host', 'Open the app at ' + origin());
    if (!SAFE_METHODS.has(req.method) && !hosts.has(String(req.headers.origin ?? '').replace(/^http:\/\//, ''))) {
      throw new HttpError(403, 'bad_origin', 'Cross-origin requests are refused.');
    }
  }

  async function handle(req, res) {
    const started = Date.now();
    let pathname = '';
    setSecurityHeaders(res);
    res.on('finish', () => log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      let url;
      try {
        url = new URL(req.url, 'http://sample.invalid');
      } catch {
        throw new HttpError(400, 'invalid_input', 'Bad request.');
      }
      pathname = url.pathname;

      // The webhook route is authenticated by its signature alone, since a real delivery carries no browser headers.
      if (pathname === WEBHOOK_PATH) {
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.');
        await receiveWebhook(req, res);
        return;
      }

      checkBrowserRequest(req);
      const match = router.match(req.method, pathname);
      if (!match) {
        if (SAFE_METHODS.has(req.method) && (await serveStatic(PUBLIC_DIR, pathname, req, res))) return;
        throw new HttpError(404, 'not_found', 'Not found.');
      }

      const ctx = { req, res, url, params: match.params, cookies: parseCookies(req) };
      if (match.route.options.auth) {
        const session = sessions.get(ctx.cookies[SESSION_COOKIE]);
        const patient = session && store.patientById(session.patientId);
        if (!(await stillExists(patient))) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
        ctx.patient = patient;
        ctx.session = session;
        // The device is the one the session signed in on, so the token it mints is the one revoked when the session ends.
        ctx.actor = { patientId: patient.id, deviceId: session.deviceId };
      }
      await match.route.handler(ctx);
    } catch (err) {
      const mapped = toHttpError(err, log);
      if (res.headersSent) res.destroy();
      else sendError(res, mapped.status, mapped.type, mapped.message);
    }
  }

  return {
    origin,
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        // Binding to loopback keeps the sample, and its developer utility, unreachable from the network.
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      }),
    sweepSessions,
    close: async () => {
      clearInterval(sweeper);
      hub.closeAll();
      // The server stops taking requests first, so no token can be minted after the ones held are revoked.
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      // A clean stop ends every session, so every token is revoked, without holding the shutdown up for long.
      await Promise.race([gateway.revokeAll(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_REVOKE_MS).unref())]);
      await closed;
    },
  };
}

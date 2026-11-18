import http from 'node:http';

// An in-process stand-in for the Spruce Public API (/api/v1) and embed host (/embed/v1), shaped from the published docs.
export async function startFakeSpruce() {
  const state = {
    credential: 'good-token',
    embedEnabled: true,
    contacts: [],
    tokens: new Map(),
    mints: 0,
    logouts: 0,
    logoutFails: false,
    rejectMessages: false,
    rejectUploads: false,
    items: [],
    idempotencyKeys: new Set(),
    media: new Map(),
    uploads: [],
    patients: new Map(),
    patientUpdates: 0,
    deletions: new Map(),
    embedded: new Set(),
    deletionRunning: false,
    unread: true,
    rotateNext: false,
    seq: 0,
  };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 's-request-id': 'req_test', ...headers });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, message, type = 'error') => send(res, status, { statusCode: status, type, message });
  const read = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  const conversationFor = (contactId) => ({
    object: 'embeddedConversation',
    id: `t_${contactId}`,
    title: 'Example Family Practice',
    participants: [
      { id: `entity_p_${contactId}`, type: 'patient', displayName: 'Pat Example' },
      { id: 'entity_org', type: 'organization', displayName: 'Example Family Practice' },
    ],
    unread: state.unread,
    lastMessageAt: state.items.findLast((item) => item.conversationId === `t_${contactId}`)?.createdAt,
    isReadOnly: false,
    createdAt: '2026-09-14T15:04:05Z',
  });

  function addItem(contactId, { authorId, authorDisplayName, text, attachments = [] }) {
    state.seq += 1;
    const at = new Date(Date.UTC(2026, 8, 15, 9, 0, state.seq)).toISOString();
    const item = {
      object: 'embeddedConversationItem',
      id: `ti_${state.seq}`,
      conversationId: `t_${contactId}`,
      patientOrganizationId: `entity_p_${contactId}`,
      type: 'message',
      authorId,
      authorDisplayName,
      createdAt: at,
      modifiedAt: at,
      deleted: false,
      message: { text, attachments },
    };
    state.items.push(item);
    return item;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const base = `http://127.0.0.1:${server.address().port}`;
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'redirect') {
      res.writeHead(302, { Location: url.searchParams.get('to') });
      res.end();
      return;
    }

    if (parts[0] === 'media') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(state.media.get(parts[1]) ?? Buffer.from('missing'));
      return;
    }

    if (parts[0] === 'api') {
      if (bearer !== state.credential) return fail(res, 403, 'Forbidden.');
      const route = `${req.method} /${parts.slice(2).join('/')}`;
      if (route === 'GET /organization') {
        return send(res, 200, { organization: { object: 'organization', id: 'entity_org', name: 'Example Family Practice', type: 'organization' } });
      }
      if (route === 'GET /internalendpoints') {
        return send(res, 200, {
          internalEndpoints: [
            { object: 'internalEndpoint', owner: {}, endpoint: { id: '15555550100', channel: 'phone', displayValue: '(555) 555-0100' } },
            { object: 'internalEndpoint', owner: {}, endpoint: { id: 'link_1', channel: 'secure', displayValue: 'spruce.care/example' } },
          ],
        });
      }
      if (route === 'POST /contacts') {
        const body = JSON.parse(await read(req));
        const contact = { object: 'contact', id: `entity_c${state.contacts.length + 1}`, ...body };
        state.contacts.push(contact);
        return send(res, 201, contact);
      }
      if (req.method === 'POST' && parts[2] === 'contacts' && parts.slice(4).join('/') === 'embed/delete') {
        const contactId = parts[3];
        if (!state.embedded.has(contactId)) return fail(res, 400, 'Contact is not an embedded patient of this organization.');
        if (state.deletionRunning) return fail(res, 409, 'The deletion is running.');
        for (const [token, holder] of state.tokens) if (holder.contactId === contactId) state.tokens.delete(token);
        state.deletions.set(contactId, '2099-01-01T00:00:00Z');
        return send(res, 200, { object: 'embedDeletion', contactId, scheduledDeletionTime: state.deletions.get(contactId) });
      }
      if (req.method === 'POST' && parts[2] === 'contacts' && parts.slice(4).join('/') === 'embed/delete/cancel') {
        const contactId = parts[3];
        if (!state.embedded.has(contactId)) return fail(res, 400, 'Contact is not an embedded patient of this organization.');
        if (state.deletionRunning) return fail(res, 409, 'The deletion is running.');
        state.deletions.delete(contactId);
        return send(res, 200, {});
      }
      if (req.method === 'POST' && parts[2] === 'contacts' && parts.slice(4).join('/') === 'embed') {
        const contactId = parts[3];
        const deviceId = req.headers['s-device-id'];
        const body = JSON.parse(await read(req));
        if (!state.embedEnabled) return fail(res, 404, 'Not found.');
        if (state.deletions.has(contactId)) return fail(res, 409, 'Deletion pending.');
        if (!deviceId || body.internalEndpointId !== 'link_1') return fail(res, 400, 'Bad request.');
        for (const [token, owner] of state.tokens) {
          if (owner.contactId === contactId && owner.deviceId === deviceId) state.tokens.delete(token);
        }
        state.embedded.add(contactId);
        state.mints += 1;
        const token = `tok_${state.mints}`;
        state.tokens.set(token, { contactId, deviceId });
        return send(res, 200, {
          contact: { id: contactId },
          embed: {
            object: 'embed',
            patientOrganizationId: `entity_p_${contactId}`,
            conversationId: `t_practice_${contactId}`,
            token,
            deviceId,
            tokenExpiresAt: '2026-11-14T15:04:05Z',
          },
        });
      }
      return fail(res, 404, 'Not found.');
    }

    if (parts[0] === 'embed') {
      const owner = state.tokens.get(bearer);
      if (!owner) return fail(res, 401, 'Unauthorized.');
      const headers = { 's-device-id': owner.deviceId };
      if (state.rotateNext) {
        state.rotateNext = false;
        state.tokens.delete(bearer);
        const rotated = `rot_${bearer}`;
        state.tokens.set(rotated, owner);
        headers['s-embed-token'] = rotated;
      }
      const { contactId } = owner;
      const route = `${req.method} /${parts.slice(2).join('/')}`;
      const conversationId = `t_${contactId}`;
      const embeddedPatient = () => ({
        object: 'embeddedPatient',
        id: `entity_p_${contactId}`,
        ...state.patients.get(contactId),
        unreadConversationCount: state.unread ? 1 : 0,
        createdAt: '2026-09-14T15:04:05Z',
      });
      if (route === 'GET /patient') return send(res, 200, embeddedPatient(), headers);
      if (route === 'POST /patient/logout') {
        if (state.logoutFails) return fail(res, 500, 'Unexpected error.');
        state.tokens.delete(bearer);
        state.logouts += 1;
        return send(res, 200, {});
      }
      if (route === 'PATCH /patient') {
        const body = JSON.parse(await read(req));
        if (body.givenName === '' || body.familyName === '') return fail(res, 400, 'A name cannot be cleared.');
        state.patientUpdates += 1;
        state.patients.set(contactId, { ...state.patients.get(contactId), ...body });
        return send(res, 200, embeddedPatient(), headers);
      }
      if (route === 'GET /conversations') return send(res, 200, { conversations: [conversationFor(contactId)] }, headers);
      if (parts[2] === 'conversations' && parts[3] !== conversationId) return fail(res, 404, 'Not found.');
      if (route === `GET /conversations/${conversationId}`) return send(res, 200, conversationFor(contactId), headers);
      if (route === `GET /conversations/${conversationId}/items`) {
        const startFrom = url.searchParams.get('startFrom');
        const token = url.searchParams.get('paginationToken');
        if (startFrom && token) return fail(res, 400, 'startFrom cannot be combined with paginationToken.');
        const order = url.searchParams.get('order') ?? 'oldest_first';
        if (order !== 'oldest_first' && order !== 'newest_first') return fail(res, 400, 'Invalid order.');
        let items = state.items.filter((item) => item.conversationId === conversationId && (!startFrom || item.createdAt >= startFrom));
        if (order === 'newest_first') items = items.toReversed();
        // The token is the offset of the next page, which is enough for a list that does not change between requests.
        const offset = token ? Number(token.replace('page_', '')) : 0;
        const end = offset + Number(url.searchParams.get('pageSize') ?? 20);
        const hasMore = end < items.length;
        return send(res, 200, { items: items.slice(offset, end), hasMore, ...(hasMore ? { paginationToken: `page_${end}` } : {}) }, headers);
      }
      if (route === `POST /conversations/${conversationId}/messages`) {
        const key = req.headers['s-idempotency-key'];
        if (key && state.idempotencyKeys.has(key)) return fail(res, 422, `Duplicate request for idempotency key "${key}".`, 'duplicate_request');
        if (key) state.idempotencyKeys.add(key);
        const body = JSON.parse(await read(req));
        if (state.rejectMessages) return fail(res, 422, 'The message could not be processed.', 'unprocessable_entity');
        const attachments = (body.attachments ?? []).map(({ mediaId }) => ({
          object: 'attachment',
          type: 'image',
          name: 'photo.png',
          mimeType: 'image/png',
          url: `${base}/media/${mediaId}`,
          urlExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        }));
        const item = addItem(contactId, { authorId: `entity_p_${contactId}`, authorDisplayName: 'Pat Example', text: body.text ?? '', attachments });
        return send(res, 200, item, headers);
      }
      if (route === `POST /conversations/${conversationId}/read`) {
        state.unread = false;
        return send(res, 200, conversationFor(contactId), headers);
      }
      if (route === 'POST /media') {
        const raw = await read(req);
        if (state.rejectUploads) return fail(res, 422, 'This file type is not accepted.', 'unprocessable_entity');
        const id = `m${state.media.size + 1}`;
        state.media.set(id, Buffer.from('PNGDATA'));
        state.uploads.push({ contentType: req.headers['content-type'], body: raw.toString('latin1') });
        return send(res, 200, { object: 'media', id }, headers);
      }
      return fail(res, 404, 'Not found.');
    }
    fail(res, 404, 'Not found.');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    addItem,
    apiUrl: `${base}/api/v1`,
    embedUrl: `${base}/embed/v1`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

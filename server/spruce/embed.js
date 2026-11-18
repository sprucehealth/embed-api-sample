import { parseResponse } from './request.js';

// Client for the Spruce embed host that owns every patient token: it mints on demand, stores rotated tokens, and mints again on 401.
export function createEmbedGateway({ baseUrl, mint, fetchImpl = fetch, timeoutMs = 30000 }) {
  const tokens = new Map();
  const minting = new Map();
  const keyOf = (actor) => `${actor.patientId}\n${actor.deviceId}`;

  // Concurrent callers for one patient device share a single mint.
  function mintFor(actor) {
    const key = keyOf(actor);
    if (!minting.has(key)) {
      const pending = (async () => {
        try {
          const token = await mint(actor.patientId, actor.deviceId);
          tokens.set(key, token);
          return token;
        } finally {
          minting.delete(key);
        }
      })();
      minting.set(key, pending);
    }
    return minting.get(key);
  }

  async function send(actor, token, method, path, { query, json, form, headers }) {
    const url = new URL(baseUrl + path);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(name, value);
    }
    return fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'S-Device-ID': actor.deviceId,
        Accept: 'application/json',
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      // A multipart body is built per attempt because a FormData stream cannot be replayed on the retry.
      body: json ? JSON.stringify(json) : form ? form() : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    async call(actor, method, path, options = {}) {
      const key = keyOf(actor);
      let token = tokens.get(key) ?? (await mintFor(actor));
      for (let attempt = 0; ; attempt++) {
        const res = await send(actor, token, method, path, options);
        const rotated = res.headers.get('s-embed-token');
        if (rotated) tokens.set(key, rotated);
        if (res.status === 401 && attempt === 0) {
          await res.arrayBuffer();
          const current = tokens.get(key);
          if (current && current !== token) {
            token = current;
          } else {
            tokens.delete(key);
            token = await mintFor(actor);
          }
          continue;
        }
        return parseResponse(res, 'embed');
      }
    },
    // Returns a device that already holds a token for the patient, so tooling can act without minting for a new device.
    liveActor(patientId) {
      for (const key of tokens.keys()) {
        const [id, deviceId] = key.split('\n');
        if (id === patientId) return { patientId, deviceId };
      }
      return null;
    },
    // Revokes the device's token on the embed host and drops it. Nothing is minted or retried: without a held token there is no session to end, and a 401 means it was already dead.
    async logout(actor) {
      const key = keyOf(actor);
      const token = tokens.get(key);
      if (!token) return;
      tokens.delete(key);
      const res = await send(actor, token, 'POST', '/patient/logout', {});
      if (res.status === 401) return void (await res.arrayBuffer());
      await parseResponse(res, 'embed');
    },
    // Revokes every token held, for when the process stops and takes every portal session with it.
    revokeAll() {
      return Promise.allSettled(
        [...tokens.keys()].map((key) => {
          const [patientId, deviceId] = key.split('\n');
          return this.logout({ patientId, deviceId });
        }),
      );
    },
    forgetPatient(patientId) {
      for (const key of tokens.keys()) if (key.split('\n')[0] === patientId) tokens.delete(key);
    },
  };
}

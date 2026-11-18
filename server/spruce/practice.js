import { parseResponse } from './request.js';

// Client for the Spruce Public API, which acts as the practice and is the only holder of the practice credential.
export function createPracticeClient({ baseUrl, credential, fetchImpl = fetch, timeoutMs = 20000 }) {
  async function call(method, path, { json, headers } = {}) {
    const res = await fetchImpl(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: 'application/json',
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return parseResponse(res, 'api');
  }

  return {
    async organization() {
      return (await call('GET', '/organization')).organization;
    },
    async internalEndpoints() {
      return (await call('GET', '/internalendpoints')).internalEndpoints;
    },
    createContact({ givenName, familyName, emailAddress }) {
      return call('POST', '/contacts', {
        json: { category: 'patient', givenName, familyName, emailAddresses: [{ value: emailAddress, label: 'Portal' }] },
      });
    },
    // Embeds the contact on first use and mints a patient token for the device on every call.
    embedContact(contactId, { deviceId, internalEndpointId }) {
      return call('POST', `/contacts/${encodeURIComponent(contactId)}/embed`, {
        json: { internalEndpointId },
        headers: { 'S-Device-ID': deviceId },
      });
    },
    // Schedules deletion of an embedded patient's Spruce data. Only the practice credential can; a patient token cannot.
    scheduleDeletion(contactId) {
      return call('POST', `/contacts/${encodeURIComponent(contactId)}/embed/delete`);
    },
    // Cancels the scheduled deletion by contact. It succeeds when nothing is pending, so it is safe to repeat.
    cancelDeletion(contactId) {
      return call('POST', `/contacts/${encodeURIComponent(contactId)}/embed/delete/cancel`);
    },
  };
}

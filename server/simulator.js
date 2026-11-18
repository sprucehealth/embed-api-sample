import { HttpError } from './http.js';
import { EVENT_ITEM_DELETED, EVENT_ITEM_RESTORED, EVENT_NOTIFICATION, signPayload } from './webhooks.js';

export const SIMULATED_EVENTS = [EVENT_NOTIFICATION, EVENT_ITEM_DELETED, EVENT_ITEM_RESTORED];

// Builds the webhook events Spruce documents, signs them like Spruce does, and delivers them to this app's own webhook route over HTTP.
export function createSimulator({ store, gateway, secret, webhookUrl, fetchImpl = fetch }) {
  async function recentItems(patientId) {
    const patient = store.patientById(patientId);
    if (!patient?.patientOrganizationId) throw new HttpError(404, 'not_found', 'This patient has not opened messaging yet.');
    // An existing token is borrowed because minting for the simulator would use one of the patient's three device slots.
    const actor = gateway.liveActor(patientId);
    if (!actor) throw new HttpError(409, 'patient_offline', 'Sign in as this patient and open Messages first.');
    // The conversation is found by listing as the patient: the id in the embed response is the practice's copy, which the embed host does not know.
    const { conversations } = await gateway.call(actor, 'GET', '/conversations');
    if (conversations.length === 0) return { patient, items: [] };
    const page = await gateway.call(actor, 'GET', `/conversations/${conversations[0].id}/items`, {
      query: { order: 'newest_first', pageSize: '50' },
    });
    return { patient, items: page.items };
  }

  function buildObject(type, patient, item) {
    if (type === EVENT_NOTIFICATION) {
      return {
        object: 'embeddedPatientNotification',
        patientOrganizationId: patient.patientOrganizationId,
        conversationId: item.conversationId,
        itemId: item.id,
        text: 'New message',
      };
    }
    const now = new Date().toISOString();
    if (type === EVENT_ITEM_DELETED) {
      return { ...item, modifiedAt: now, deleted: true, deletedAt: now, message: { text: '', attachments: [] } };
    }
    const { deletedAt, ...restored } = item;
    return { ...restored, modifiedAt: now, deleted: false };
  }

  // Signed attachment URLs are withheld from the copy shown in the developer utility.
  function redact(event) {
    const copy = structuredClone(event);
    for (const attachment of copy.data.object.message?.attachments ?? []) attachment.url = '[signed URL withheld]';
    return copy;
  }

  return {
    async listItems(patientId) {
      const { items } = await recentItems(patientId);
      return items
        .filter((item) => item.type === 'message')
        .map((item) => ({
          id: item.id,
          createdAt: item.createdAt,
          deleted: item.deleted,
          author: item.authorDisplayName ?? '',
          text: item.message?.text ?? '',
          attachmentCount: item.message?.attachments?.length ?? 0,
        }));
    },
    async send({ patientId, type, itemId }) {
      if (!SIMULATED_EVENTS.includes(type)) throw new HttpError(400, 'invalid_input', 'Unknown event type.');
      const { patient, items } = await recentItems(patientId);
      const item = items.find((candidate) => candidate.id === itemId && candidate.type === 'message');
      if (!item) throw new HttpError(404, 'not_found', 'That message is not among the recent items.');
      const event = {
        eventTime: new Date().toISOString(),
        object: 'event',
        type,
        data: { object: buildObject(type, patient, item) },
      };
      const payload = JSON.stringify(event);
      const res = await fetchImpl(webhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Spruce-Signature': signPayload(secret, payload) },
        body: payload,
        signal: AbortSignal.timeout(10000),
      });
      await res.arrayBuffer();
      return { status: res.status, event: redact(event) };
    },
  };
}

import { createHmac, timingSafeEqual } from 'node:crypto';

export const EVENT_NOTIFICATION = 'embeddedPatientNotification.created';
export const EVENT_ITEM_DELETED = 'embeddedConversationItem.deleted';
export const EVENT_ITEM_RESTORED = 'embeddedConversationItem.restored';

// Computes the X-Spruce-Signature value for a payload: the Base64 HMAC-SHA256 of the raw body under the endpoint secret.
export function signPayload(secret, rawBody) {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

// Verifies the signature against the raw bytes received, in constant time.
export function verifySignature(secret, rawBody, signatureHeader) {
  if (typeof signatureHeader !== 'string' || signatureHeader === '') return false;
  const given = Buffer.from(signatureHeader, 'base64');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Routes one verified event to the patient it concerns; events for unknown patients or of other types are acknowledged and ignored.
export function createWebhookHandler({ store, hub, attachments, log }) {
  return function handle(event) {
    const object = event?.data?.object;
    if (event?.object !== 'event' || typeof event.type !== 'string' || !object) return 'ignored';
    const patient = store.patientByOrganizationId(object.patientOrganizationId);
    if (!patient) {
      log(`webhook ${event.type}: no patient for this patientOrganizationId, ignored`);
      return 'ignored';
    }
    switch (event.type) {
      case EVENT_NOTIFICATION:
        hub.publish(patient.id, 'notification', {
          conversationId: object.conversationId,
          itemId: object.itemId,
          text: object.text,
        });
        return 'handled';
      case EVENT_ITEM_DELETED:
      case EVENT_ITEM_RESTORED:
        hub.publish(patient.id, 'item', { item: attachments.sanitizeItem(patient.id, object) });
        return 'handled';
      default:
        return 'ignored';
    }
  };
}

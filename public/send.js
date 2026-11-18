import { ApiError, api as portalApi } from './api.js';

// The error type Spruce answers, with 422, when an S-Idempotency-Key was already claimed by an earlier request.
const DUPLICATE_REQUEST = 'duplicate_request';

// Uploads any attachment not yet uploaded, then posts under the entry's idempotency key; a retry reuses both.
// Returns the posted item, or null when Spruce reports that an earlier attempt already claimed the key.
export async function deliverMessage(entry, conversationPath, api = portalApi) {
  // An upload carries no idempotency key, so any error from one is a failure and the message is not posted.
  for (const file of entry.files) {
    if (file.mediaId) continue;
    const media = await api('POST', '/api/media', {
      body: file.file,
      headers: {
        'Content-Type': file.file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.file.name),
      },
    });
    file.mediaId = media.id;
  }
  try {
    return await api('POST', `${conversationPath}/messages`, {
      json: { text: entry.text, attachments: entry.files.map((file) => ({ mediaId: file.mediaId })) },
      headers: { 'Idempotency-Key': entry.key },
    });
  } catch (err) {
    // Only the duplicate-key type means "already accepted"; any other 422 is a refusal and must reach the patient.
    if (err instanceof ApiError && err.status === 422 && err.type === DUPLICATE_REQUEST) return null;
    throw err;
  }
}

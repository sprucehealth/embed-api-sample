// An error answered by one of the Spruce hosts, carrying the documented error fields and the request id for support.
export class SpruceError extends Error {
  constructor({ status, type, message, requestId, host }) {
    super(message);
    this.status = status;
    this.type = type;
    this.requestId = requestId;
    this.host = host;
  }
}

// Returns the parsed JSON body of a successful response and throws a SpruceError for any other status.
export async function parseResponse(res, host) {
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    throw new SpruceError({
      status: res.status,
      type: body?.type ?? 'error',
      message: body?.message ?? `HTTP ${res.status}`,
      requestId: res.headers.get('s-request-id') ?? '',
      host,
    });
  }
  return body;
}

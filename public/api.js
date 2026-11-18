export class ApiError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

let onSignedOut = () => {};
export function setSignedOutHandler(handler) {
  onSignedOut = handler;
}

// Calls the sample backend, the only server this page ever talks to.
export async function api(method, path, { json, body, headers } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
    });
  } catch {
    throw new ApiError(0, 'network', 'The portal could not be reached. Check your connection and try again.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const error = new ApiError(res.status, data?.type ?? 'error', data?.message ?? 'Something went wrong.');
    if (error.type === 'unauthenticated') onSignedOut();
    throw error;
  }
  return data;
}

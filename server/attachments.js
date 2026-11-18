import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

// Keeps the signed attachment URLs on the server and hands the browser an opaque key bound to the patient instead.
export function createAttachmentRegistry({ max = 2000 } = {}) {
  const records = new Map();
  const keys = new Map();

  // An attachment keeps one key however often its item is fetched, so a refetch renews the link behind a URL the page already holds.
  function register(patientId, itemId, index, attachment) {
    const slot = `${patientId}/${itemId}/${index}`;
    const key = keys.get(slot) ?? randomBytes(18).toString('base64url');
    keys.set(slot, key);
    // Setting the record again moves it to the end, so the entry dropped at the limit is the one fetched longest ago.
    records.delete(key);
    records.set(key, {
      slot,
      patientId,
      url: attachment.url,
      expiresAt: Date.parse(attachment.urlExpiresAt),
      mimeType: attachment.mimeType,
      name: attachment.name,
    });
    if (records.size > max) {
      const [oldest, record] = records.entries().next().value;
      records.delete(oldest);
      keys.delete(record.slot);
    }
    return key;
  }

  return {
    get: (key) => records.get(key) ?? null,
    // Returns a copy of the item whose attachments carry a same-origin href in place of the signed URL.
    sanitizeItem(patientId, item) {
      if (!item?.message?.attachments?.length) return item;
      return {
        ...item,
        message: {
          ...item.message,
          attachments: item.message.attachments.map((attachment, index) => ({
            type: attachment.type,
            name: attachment.name,
            mimeType: attachment.mimeType,
            href: `/api/attachments/${register(patientId, item.id, index, attachment)}`,
            expiresAt: attachment.urlExpiresAt,
          })),
        },
      };
    },
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Builds the test for a URL the attachment proxy may fetch: https on the configured Spruce hosts' domain or a listed media host.
// A loopback Spruce host, as the tests use, is matched exactly, port included.
export function createMediaHostCheck({ apiUrl, embedUrl, mediaHosts = [] }) {
  const exact = new Set(mediaHosts.map((host) => host.toLowerCase()));
  const loopback = new Set();
  const domains = new Set();
  for (const base of [apiUrl, embedUrl]) {
    const { hostname, host } = new URL(base);
    if (LOOPBACK_HOSTS.has(hostname)) {
      loopback.add(host);
      continue;
    }
    const labels = hostname.split('.');
    // api.sprucehealth.com allows sprucehealth.com and its subdomains; an IP address or a host with no subdomain allows only itself.
    if (labels.length > 2 && !isIP(hostname.replace(/^\[|\]$/g, ''))) domains.add(labels.slice(1).join('.'));
    else exact.add(hostname);
  }
  return (raw) => {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (loopback.has(url.host)) return true;
    if (url.protocol !== 'https:') return false;
    if (exact.has(url.hostname)) return true;
    return [...domains].some((domain) => url.hostname === domain || url.hostname.endsWith('.' + domain));
  };
}

import { randomBytes } from 'node:crypto';
import path from 'node:path';

const DEFAULT_API_URL = 'https://api.sprucehealth.com/v1';
const DEFAULT_EMBED_URL = 'https://embed.sprucehealth.com/v1';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Reads one line from the terminal without echoing it, so the credential never lands on screen or in shell history.
export function promptHidden(question, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(new Error('No terminal is attached, so the API token cannot be prompted for. Start the sample from a terminal.'));
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// Reads one echoed line, used for choices that are not secret.
export function promptLine(question, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(new Error('No terminal is attached to answer: ' + question.trim()));
      return;
    }
    stdout.write(question);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.once('data', (chunk) => {
      stdin.pause();
      resolve(String(chunk).trim());
    });
  });
}

// The docs show the bearer value both as a ready token and as base64(access_id:secret_key); a pasted "id:secret" pair is encoded here.
export function normalizeCredential(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('The API token is empty.');
  if (value.includes(':')) return Buffer.from(value, 'utf8').toString('base64');
  return value;
}

function parseBaseUrl(name, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(`${name} must use https (http is accepted only for a loopback host).`);
  }
  return url.href.replace(/\/+$/, '');
}

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a number between 0 and 65535.');
  return port;
}

function parseHosts(raw) {
  const hosts = String(raw ?? '').split(',').map((host) => host.trim()).filter(Boolean);
  for (const host of hosts) {
    if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('SPRUCE_MEDIA_HOSTS must be a comma-separated list of host names.');
  }
  return hosts;
}

const FLAGS = new Set(['api-url', 'embed-url', 'port']);

// Parses "--name value" and "--name=value" start-command flags; the credential is deliberately not accepted as a flag.
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (!FLAGS.has(name)) throw new Error(`Unknown flag --${name}. Known flags: --api-url, --embed-url, --port.`);
    const value = inline ?? argv[++i];
    if (value === undefined || value === '') throw new Error(`Flag --${name} needs a value.`);
    flags[name] = value;
  }
  return flags;
}

// Both Spruce hosts default to production; a start-command flag wins over the matching environment variable.
export async function loadConfig({ env = process.env, argv = [], prompt = promptHidden } = {}) {
  const flags = parseFlags(argv);
  const config = {
    port: parsePort(flags.port ?? env.PORT ?? '4400'),
    apiUrl: parseBaseUrl('The Public API URL', flags['api-url'] ?? env.SPRUCE_API_URL ?? DEFAULT_API_URL),
    embedUrl: parseBaseUrl('The embed host URL', flags['embed-url'] ?? env.SPRUCE_EMBED_URL ?? DEFAULT_EMBED_URL),
    internalEndpointId: env.SPRUCE_INTERNAL_ENDPOINT_ID || '',
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    // Extra hosts the attachment proxy may fetch from, for an environment whose media host is outside its API hosts' domain.
    mediaHosts: parseHosts(env.SPRUCE_MEDIA_HOSTS),
    // The simulator signs its events with this secret and the webhook route verifies them with it, so it only has to last for the run.
    webhookSecret: randomBytes(32).toString('base64'),
  };
  const raw = await prompt('Spruce API token (input hidden): ');
  // The credential is a non-enumerable property so that logging the config object can never print it.
  Object.defineProperty(config, 'credential', { value: normalizeCredential(raw), enumerable: false });
  return config;
}

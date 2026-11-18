import { api, setSignedOutHandler } from './api.js';
import { h, icon, initials } from './ui.js';
import { accountView } from './views/account.js';
import { homeView } from './views/home.js';
import { messagesView } from './views/messages.js';
import { signinView } from './views/signin.js';

const NAV = [
  { id: 'home', label: 'Home', href: '#/', icon: 'home' },
  { id: 'messages', label: 'Messages', href: '#/messages', icon: 'message' },
  { id: 'account', label: 'Account', href: '#/account', icon: 'user' },
];

const ROUTES = {
  messages: (ctx, id) => messagesView(ctx, id),
  account: accountView,
};

const side = document.getElementById('side');
const top = document.getElementById('top');
const tabs = document.getElementById('tabs');
const viewRoot = document.getElementById('view');
const toasts = document.getElementById('toasts');

const state = { patient: null, practice: { name: 'Patient portal' }, unread: 0 };
// How long to wait before opening the event stream again after the browser gave up on it.
const STREAM_RETRY_MS = 60_000;
// A count fetched this recently is shown as it is on navigation; a webhook event or a reconnect fetches it again at once.
const UNREAD_FRESH_MS = 60_000;

let current = null;
let events = null;
let connecting = null;
let unreadAt = 0;

const ctx = {
  state,
  navigate(hash, { replace = false } = {}) {
    if (location.hash === hash) route();
    else if (replace) location.replace(hash);
    else location.hash = hash;
  },
  signedIn(result) {
    state.patient = result.patient;
    state.practice = result.practice;
    openEvents();
    ctx.navigate('#/');
  },
  patientUpdated(patient) {
    state.patient = patient;
    connecting = null;
    if (patient.deletionScheduledFor) setUnread(0);
    renderChrome();
  },
  async signOut() {
    await api('POST', '/api/logout').catch(() => {});
    signedOut();
  },
  // Embeds the patient on first use; later calls in the same page load reuse the first result.
  connect() {
    if (state.patient.deletionScheduledFor) {
      return Promise.reject(new Error('Messaging is closed while your account is scheduled for deletion. You can keep your account from the Account page.'));
    }
    connecting ??= api('POST', '/api/messaging/connect').then(
      (result) => {
        state.patient = result.patient;
        setUnread(result.unreadConversationCount);
        return result;
      },
      (err) => {
        connecting = null;
        throw err;
      },
    );
    return connecting;
  },
  // Fetches the unread count unless one is already in hand: the Messages page reads it from the conversation list,
  // and a count fetched less than UNREAD_FRESH_MS ago is reused unless force is set.
  async refreshUnread({ force = false } = {}) {
    if (!state.patient?.connected || state.patient.deletionScheduledFor) return;
    if (current?.tracksUnread) return;
    if (!force && Date.now() - unreadAt < UNREAD_FRESH_MS) return;
    unreadAt = Date.now();
    try {
      setUnread((await api('GET', '/api/patient')).unreadConversationCount);
    } catch {
      // The marker is refreshed again on the next navigation or notification.
      unreadAt = 0;
    }
  },
  setUnread,
  // True while the event stream is connected; the fallback polls of the Messages page slow down then.
  streamUp: () => events?.readyState === EventSource.OPEN,
  toast,
};

function setUnread(count) {
  unreadAt = Date.now();
  state.unread = count;
  for (const dot of document.querySelectorAll('[data-unread]')) dot.hidden = !(count > 0);
  current?.onUnread?.(count);
}

function signedOut() {
  state.patient = null;
  state.unread = 0;
  unreadAt = 0;
  connecting = null;
  events?.close();
  events = null;
  ctx.navigate('#/signin');
}

// One server-sent event stream carries what the backend learned from webhooks to this patient's open pages.
// These events are what refresh the page; the views poll only slowly, as a fallback.
function openEvents({ dropped = false } = {}) {
  events?.close();
  const source = new EventSource('/api/events');
  events = source;
  // The browser reconnects by itself after a drop. Events sent meanwhile are lost, so the page refreshes on reconnecting.
  source.addEventListener('error', () => {
    dropped = true;
    // After an error response, such as a 502 from a proxy, the browser gives up for good, so the stream is opened again later.
    if (source.readyState === EventSource.CLOSED) {
      setTimeout(() => events === source && openEvents({ dropped: true }), STREAM_RETRY_MS);
    }
  });
  source.addEventListener('open', () => {
    if (!dropped) return;
    dropped = false;
    current?.onResync?.();
    ctx.refreshUnread({ force: true });
  });
  source.addEventListener('notification', (event) => {
    const notification = JSON.parse(event.data);
    // On the Messages page the conversation list is fetched again and carries the unread flags, so this is skipped there.
    ctx.refreshUnread({ force: true });
    if (current?.onNotification?.(notification)) return;
    toast(`${notification.text} from ${state.practice.name}`, {
      label: 'Read',
      run: () => ctx.navigate(`#/messages/${encodeURIComponent(notification.conversationId)}`),
    });
  });
  source.addEventListener('item', (event) => current?.onItem?.(JSON.parse(event.data).item));
}

function toast(text, action) {
  const dismiss = () => el.remove();
  const el = h(
    'div',
    { class: 'toast' },
    icon('message'),
    h('span', {}, text),
    action &&
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            dismiss();
            action.run();
          },
        },
        action.label,
      ),
  );
  toasts.append(el);
  setTimeout(dismiss, 8000);
}

function navLink(item) {
  const active = current?.nav === item.id;
  return h(
    'a',
    { href: item.href, class: `nav-${item.id}`, 'aria-current': active ? 'page' : undefined },
    icon(item.icon),
    h('span', {}, item.label),
    item.id === 'messages' && h('i', { class: 'dot', 'data-unread': true, hidden: !(state.unread > 0), title: 'Unread messages' }),
  );
}

function renderChrome() {
  const name = `${state.patient.givenName} ${state.patient.familyName}`;
  side.replaceChildren(
    h(
      'a',
      { class: 'brand', href: '#/' },
      h('span', { class: 'monogram', 'aria-hidden': 'true' }, initials(state.practice.name)),
      h('span', {}, h('strong', {}, state.practice.name), h('small', {}, 'Patient portal')),
    ),
    h('nav', { 'aria-label': 'Sections' }, NAV.filter((item) => item.id !== 'account').map((item) => navLink(item))),
    h(
      'a',
      { class: 'who', href: '#/account', 'aria-current': current?.nav === 'account' ? 'page' : undefined },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name)),
      h('span', {}, h('strong', {}, name), h('small', {}, 'Account and sign out')),
    ),
  );
  top.replaceChildren(h('h1', {}, current.title));
  tabs.replaceChildren(...NAV.map((item) => navLink(item)));
}

function route() {
  current?.destroy?.();
  let parts = [];
  try {
    parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    // An address that cannot be decoded names no page, so the home page is shown.
  }
  if (!state.patient) {
    current = signinView(ctx);
    side.replaceChildren();
    top.replaceChildren();
    tabs.replaceChildren();
  } else {
    current = (ROUTES[parts[0]] ?? homeView)(ctx, parts[1]);
    renderChrome();
    ctx.refreshUnread();
  }
  document.body.classList.toggle('signed-out', !state.patient);
  viewRoot.replaceChildren(current.el);
  viewRoot.className = current.className ?? '';
  viewRoot.scrollTop = 0;
  document.title = `${current.title} | ${state.practice.name}`;
}

setSignedOutHandler(() => {
  if (state.patient) signedOut();
});

window.addEventListener('hashchange', route);

try {
  const me = await api('GET', '/api/me');
  state.patient = me.patient;
  state.practice = me.practice;
  openEvents();
} catch {
  // Not signed in yet; the practice name is still needed for the sign-in screen.
  state.practice = await api('GET', '/api/practice').catch(() => state.practice);
}
route();

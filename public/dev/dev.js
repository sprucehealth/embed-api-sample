import { api } from '../api.js';
import { formatRecent, h } from '../ui.js';

const LABELS = {
  'embeddedPatientNotification.created': 'Notification',
  'embeddedConversationItem.deleted': 'Deleted',
  'embeddedConversationItem.restored': 'Restored',
};

const root = document.getElementById('dev');
const select = h('select', { 'aria-label': 'Patient', onChange: () => loadItems() });
const table = h('div', { class: 'scroll' });
const log = h('div');
let eventTypes = [];

const showLoadError = (err) => table.replaceChildren(h('p', { class: 'error', role: 'alert' }, err.message));

async function loadState() {
  const state = await api('GET', '/dev/api/state');
  eventTypes = state.eventTypes;
  const previous = select.value;
  select.replaceChildren(
    ...state.patients.map((patient) =>
      h('option', { value: patient.id }, `${patient.name} (${patient.email})${patient.online ? '' : ' · not signed in'}`),
    ),
  );
  if (state.patients.some((patient) => patient.id === previous)) select.value = previous;
  if (state.patients.length === 0) {
    table.replaceChildren(h('p', { class: 'muted' }, 'No embedded patients yet. Create an account in the portal and open Messages.'));
    return;
  }
  await loadItems();
}

async function loadItems() {
  try {
    const { items } = await api('GET', `/dev/api/patients/${encodeURIComponent(select.value)}/items`);
    if (items.length === 0) {
      table.replaceChildren(h('p', { class: 'muted' }, 'This conversation has no messages yet.'));
      return;
    }
    table.replaceChildren(
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Author'), h('th', {}, 'Message'), h('th', {}, 'Send event'))),
        h(
          'tbody',
          {},
          items.map((item) =>
            h(
              'tr',
              {},
              h('td', {}, formatRecent(item.createdAt)),
              h('td', {}, item.author || 'Unknown'),
              h(
                'td',
                {},
                item.deleted ? '(deleted)' : item.text || '(no text)',
                item.attachmentCount > 0 && ` [${item.attachmentCount} attachment${item.attachmentCount > 1 ? 's' : ''}]`,
              ),
              h(
                'td',
                { class: 'actions' },
                eventTypes.map((type) => h('button', { type: 'button', title: type, onClick: () => simulate(type, item.id) }, LABELS[type] ?? type)),
              ),
            ),
          ),
        ),
      ),
    );
  } catch (err) {
    table.replaceChildren(h('p', { class: 'error', role: 'alert' }, err.message));
  }
}

async function simulate(type, itemId) {
  try {
    const result = await api('POST', '/dev/api/simulate', { json: { patientId: select.value, type, itemId } });
    log.prepend(
      h(
        'div',
        { class: 'card' },
        h('strong', {}, `${type} → webhook answered ${result.status}`),
        h('pre', {}, JSON.stringify(result.event, null, 2)),
      ),
    );
  } catch (err) {
    log.prepend(h('div', { class: 'card' }, h('p', { class: 'error', role: 'alert' }, err.message)));
  }
}

root.append(
  h('h1', {}, 'Webhook simulator'),
  h('p', { class: 'muted' }, 'Developer utility for the Spruce Embedded Secure Messaging API sample. It exists only on this machine.'),
  h(
    'div',
    { class: 'card notice' },
    h(
      'p',
      {},
      'Each button builds the event Spruce documents, signs it with X-Spruce-Signature, and POSTs it to this app’s own /webhooks/spruce route. ',
      'The handler that runs is the one a real Spruce delivery would reach, so no webhook endpoint needs to be registered.',
    ),
    h(
      'p',
      { class: 'muted' },
      'A simulated event changes nothing in Spruce. A simulated deletion is shown in the open thread until the thread is refetched; to see a real one, delete the message in Spruce first.',
    ),
  ),
  h('div', { class: 'card' }, h('label', { class: 'field' }, h('span', {}, 'Patient'), select), h('button', { type: 'button', class: 'secondary', onClick: () => loadState().catch(showLoadError) }, 'Refresh'), table),
  h('h2', {}, 'Sent events'),
  log,
);

loadState().catch(showLoadError);

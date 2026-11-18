import { api } from '../api.js';
import { h } from '../ui.js';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });

export function accountView(ctx) {
  const { patient, practice } = ctx.state;
  const field = (label, props) => h('label', { class: 'field' }, h('span', {}, label), h('input', props));
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const saved = h('span', { class: 'saved', role: 'status' });
  const save = h('button', { type: 'submit', class: 'primary', disabled: Boolean(patient.deletionScheduledFor) }, 'Save changes');

  async function submit(event) {
    event.preventDefault();
    const data = new FormData(form);
    error.hidden = true;
    saved.textContent = '';
    save.disabled = true;
    try {
      const result = await api('PATCH', '/api/account', {
        json: {
          givenName: data.get('givenName'),
          familyName: data.get('familyName'),
        },
      });
      ctx.patientUpdated(result.patient);
      saved.textContent = 'Changes saved';
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      save.disabled = false;
    }
  }

  const pendingDeletion = Boolean(patient.deletionScheduledFor);
  const deletionError = h('p', { class: 'error', role: 'alert', hidden: true });
  const deletionBody = h('div', {});

  // Both deletion actions answer with the patient, and the page is drawn again from it.
  async function changeDeletion(path, button) {
    deletionError.hidden = true;
    button.disabled = true;
    try {
      ctx.patientUpdated((await api('POST', path)).patient);
      ctx.navigate('#/account');
    } catch (err) {
      deletionError.textContent = err.message;
      deletionError.hidden = false;
      button.disabled = false;
    }
  }

  function showDeletionPrompt() {
    const request = h('button', { type: 'button', class: 'secondary danger', onClick: showDeletionConfirm }, 'Request account deletion');
    deletionBody.replaceChildren(
      h('p', { class: 'muted' }, `Deleting your account removes your portal account and your messages with ${practice.name}.`),
      request,
    );
  }

  function showDeletionConfirm() {
    const confirm = h('button', { type: 'button', class: 'danger-solid', onClick: () => changeDeletion('/api/account/deletion', confirm) }, 'Delete my account');
    deletionBody.replaceChildren(
      h('p', {}, 'Your account will be deleted after 30 days. Messaging closes right away, and you can keep your account at any time before the deletion date.'),
      h('div', { class: 'actions' }, confirm, h('button', { type: 'button', class: 'secondary', onClick: showDeletionPrompt }, 'Cancel')),
    );
    confirm.focus();
  }

  if (pendingDeletion) {
    const keep = h('button', { type: 'button', class: 'primary', onClick: () => changeDeletion('/api/account/deletion/cancel', keep) }, 'Keep my account');
    deletionBody.replaceChildren(
      h('p', {}, `Your account is scheduled for deletion on ${dateFormat.format(new Date(patient.deletionScheduledFor))}. Messaging is closed until then.`),
      keep,
    );
  } else {
    showDeletionPrompt();
  }

  const form = h(
    'form',
    { class: 'account-form', onSubmit: submit },
    h(
      'div',
      { class: 'row' },
      field('First name', { name: 'givenName', value: patient.givenName, required: true, autocomplete: 'given-name', maxLength: 80 }),
      field('Last name', { name: 'familyName', value: patient.familyName, required: true, autocomplete: 'family-name', maxLength: 80 }),
    ),
    error,
    h('div', { class: 'actions' }, save, saved),
  );

  const el = h(
    'div',
    { class: 'page narrow' },
    h(
      'section',
      { class: 'panel' },
      h('header', {}, h('h3', {}, 'Your details')),
      form,
      h(
        'dl',
        { class: 'details' },
        h('dt', {}, 'Email'),
        h('dd', {}, patient.email),
        h('dt', {}, 'Practice'),
        h('dd', {}, practice.name),
        h('dt', {}, 'Secure messaging'),
        h('dd', {}, patient.connected ? 'Set up' : 'Set up the first time you open Messages'),
      ),
      h('div', { class: 'panel-footer' }, h('button', { type: 'button', class: 'secondary', onClick: () => ctx.signOut() }, 'Sign out')),
    ),
    h('section', { class: 'panel' }, h('header', {}, h('h3', {}, pendingDeletion ? 'Account deletion scheduled' : 'Delete your account')), deletionBody, deletionError),
    h(
      'section',
      { class: 'panel' },
      h('header', {}, h('h3', {}, 'For developers')),
      h('p', { class: 'muted' }, 'This portal is sample code for the Spruce Embedded Secure Messaging API. The webhook simulator sends the events Spruce would deliver about this patient.'),
      h('a', { class: 'button-like quiet', href: '/dev/', target: '_blank', rel: 'noopener' }, 'Open the webhook simulator'),
    ),
  );
  return { el, title: 'Account', nav: 'account' };
}

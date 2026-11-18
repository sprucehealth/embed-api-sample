import { api } from '../api.js';
import { h, initials } from '../ui.js';

export function signinView(ctx) {
  const { practice } = ctx.state;
  let mode = 'login';
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const panel = h('div', { class: 'signin-form' });

  const field = (label, props) => h('label', { class: 'field' }, h('span', {}, label), h('input', { required: true, ...props }));

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    error.hidden = true;
    try {
      ctx.signedIn(await api('POST', mode === 'login' ? '/api/login' : '/api/signup', { json: values }));
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      button.disabled = false;
    }
  }

  function render() {
    const signup = mode === 'signup';
    error.hidden = true;
    panel.replaceChildren(
      h('h2', {}, signup ? 'Create your portal account' : 'Sign in to your portal'),
      h(
        'form',
        { onSubmit: submit },
        signup &&
          h(
            'div',
            { class: 'row' },
            field('First name', { name: 'givenName', autocomplete: 'given-name', maxLength: 80 }),
            field('Last name', { name: 'familyName', autocomplete: 'family-name', maxLength: 80 }),
          ),
        field('Email', { name: 'email', type: 'email', autocomplete: 'username', maxLength: 254 }),
        field('Password', {
          name: 'password',
          type: 'password',
          autocomplete: signup ? 'new-password' : 'current-password',
          maxLength: 200,
        }),
        error,
        h('button', { type: 'submit', class: 'primary wide' }, signup ? 'Create account' : 'Sign in'),
      ),
      h(
        'p',
        { class: 'switch' },
        signup ? 'Already have an account? ' : 'New to the portal? ',
        h(
          'button',
          {
            type: 'button',
            class: 'link',
            onClick: () => {
              mode = signup ? 'login' : 'signup';
              render();
            },
          },
          signup ? 'Sign in' : 'Create an account',
        ),
      ),
    );
  }

  const el = h(
    'div',
    { class: 'signin' },
    h(
      'section',
      { class: 'signin-brand' },
      h('span', { class: 'monogram', 'aria-hidden': 'true' }, initials(practice.name)),
      h('p', { class: 'practice' }, practice.name),
      h('h1', {}, 'Your care, in one place.'),
    ),
    h('section', { class: 'signin-panel' }, panel),
  );

  render();
  return { el, title: 'Sign in', className: 'bare' };
}

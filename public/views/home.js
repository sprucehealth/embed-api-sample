import { h, icon } from '../ui.js';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  return hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function homeView(ctx) {
  const { patient, practice } = ctx.state;
  const messagesState = h('p', { class: 'muted' });
  const messagesCard = h(
    'a',
    { class: 'panel messages-panel', href: '#/messages' },
    h('span', { class: 'panel-icon' }, icon('message')),
    h('div', {}, h('h3', {}, 'Messages'), messagesState),
    h('span', { class: 'button-like' }, 'Open messages'),
  );

  // The count is of conversations with unread messages, so it is worded as a state and not as a number of messages.
  const showUnread = (count) => {
    messagesCard.classList.toggle('attention', count > 0);
    messagesState.textContent = count > 0 ? `You have unread messages from ${practice.name}.` : `Ask ${practice.name} a question, any time.`;
  };
  showUnread(ctx.state.unread);
  ctx.refreshUnread();
  if (patient.deletionScheduledFor) messagesState.textContent = 'Messaging is closed while your account is scheduled for deletion.';

  const el = h('div', { class: 'page home' }, h('h2', { class: 'greeting' }, `${greeting()}, ${patient.givenName}.`), messagesCard);

  return { el, title: 'Home', nav: 'home', onUnread: showUnread };
}

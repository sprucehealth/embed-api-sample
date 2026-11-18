import { h, icon } from '../ui.js';
import { conversationList } from './conversations.js';
import { threadView } from './thread.js';

// The Messages section: the conversation list and the open thread side by side, or one at a time on a phone.
export function messagesView(ctx, conversationId) {
  const list = conversationList(ctx, conversationId);
  const thread = conversationId ? threadView(ctx, conversationId) : null;
  const el = h(
    'div',
    { class: thread ? 'inbox has-thread' : 'inbox' },
    h('div', { class: 'inbox-list' }, list.el),
    h(
      'div',
      { class: 'inbox-thread' },
      thread ? thread.el : h('div', { class: 'empty' }, icon('message'), h('p', {}, 'Choose a conversation to read it.')),
    ),
  );

  return {
    el,
    title: 'Messages',
    nav: 'messages',
    className: 'fill',
    destroy() {
      list.destroy();
      thread?.destroy();
    },
    onNotification(notification) {
      list.reload();
      return thread?.onNotification(notification) ?? false;
    },
    onItem: (item) => thread?.onItem(item),
    onUnread: () => list.reload(),
  };
}

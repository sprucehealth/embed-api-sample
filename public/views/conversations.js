import { api } from '../api.js';
import { conversationAvatar, formatRecent, h, participantNames } from '../ui.js';

const WIDE = window.matchMedia('(min-width: 900px)');
const POLL_MS = 5000;

// The list of the patient's conversations, shown beside the open thread on wide screens.
export function conversationList(ctx, selectedId) {
  const el = h('div', { class: 'conversation-list' }, h('p', { class: 'muted pad' }, 'Opening messages…'));
  let destroyed = false;
  let loading = false;

  // A quiet reload keeps the list on screen when the request fails, so one missed poll does not replace it with an error.
  async function reload({ quiet = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      await ctx.connect();
      const { conversations } = await api('GET', '/api/conversations');
      if (destroyed) return;
      if (conversations.length === 0) {
        el.replaceChildren(h('p', { class: 'muted pad' }, 'You have no conversations yet.'));
        return;
      }
      // With room for two panes, the most recent conversation opens without an extra click.
      if (!selectedId && WIDE.matches) {
        ctx.navigate(`#/messages/${encodeURIComponent(conversations[0].id)}`, { replace: true });
        return;
      }
      el.replaceChildren(
        ...conversations.map((conversation) =>
          h(
            'a',
            {
              class: 'conversation',
              href: `#/messages/${encodeURIComponent(conversation.id)}`,
              'aria-current': conversation.id === selectedId ? 'true' : undefined,
            },
            conversationAvatar(conversation),
            h(
              'span',
              { class: 'conversation-text' },
              h('strong', {}, participantNames(conversation)),
              h('small', {}, conversation.lastMessageAt ? `Last message ${formatRecent(conversation.lastMessageAt)}` : 'No messages yet'),
            ),
            conversation.unread && h('i', { class: 'dot', title: 'Unread messages' }),
          ),
        ),
      );
    } catch (err) {
      if (!destroyed && !quiet) el.replaceChildren(h('p', { class: 'error pad', role: 'alert' }, err.message));
    } finally {
      loading = false;
    }
  }

  reload();
  // Nothing announces a conversation the practice starts, so the list is fetched again while the page is visible.
  const timer = setInterval(() => !document.hidden && reload({ quiet: true }), POLL_MS);
  return {
    el,
    reload,
    destroy() {
      destroyed = true;
      clearInterval(timer);
    },
  };
}

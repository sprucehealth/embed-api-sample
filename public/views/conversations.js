import { api } from '../api.js';
import { createFallback } from '../refresh.js';
import { conversationAvatar, formatRecent, h, participantNames } from '../ui.js';

const WIDE = window.matchMedia('(min-width: 900px)');

// The number of conversations with unread messages, the same count GET /patient answers, taken from a list already fetched.
export const unreadCount = (conversations) => conversations.filter((conversation) => conversation.unread).length;

// The list of the patient's conversations, shown beside the open thread on wide screens.
// It is fetched again when a webhook event arrives, when the event stream reconnects, after a send, and on the slow fallback schedule.
export function conversationList(ctx, selectedId) {
  const el = h('div', { class: 'conversation-list' }, h('p', { class: 'muted pad' }, 'Opening messages…'));
  let destroyed = false;
  let conversations = null;
  let fetched = '';
  // A thread can be marked read before the first list arrives; that list may predate the read, so the read is applied to it.
  let readBeforeLoad = null;

  // Fetches the list and draws it. Resolves true when it changed; throws on failure so the fallback backs off.
  async function fetchList() {
    await ctx.connect();
    const result = await api('GET', '/api/conversations');
    if (destroyed) return false;
    const changed = JSON.stringify(result.conversations) !== fetched;
    fetched = JSON.stringify(result.conversations);
    conversations = result.conversations;
    if (readBeforeLoad) apply(readBeforeLoad);
    readBeforeLoad = null;
    ctx.setUnread(unreadCount(conversations));
    draw();
    return changed;
  }

  function apply(conversation) {
    const index = conversations.findIndex((known) => known.id === conversation.id);
    if (index === -1) return false;
    conversations[index] = { ...conversations[index], unread: conversation.unread ?? false };
    return true;
  }

  function draw() {
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
  }

  // The first load shows its error; later refreshes keep the list on screen when a request fails.
  const fallback = createFallback(fetchList, { streamUp: ctx.streamUp });
  fetchList()
    .catch((err) => {
      if (!destroyed) el.replaceChildren(h('p', { class: 'error pad', role: 'alert' }, err.message));
    })
    .finally(() => !destroyed && fallback.start());

  return {
    el,
    // Webhooks may not announce every change, such as a conversation the practice starts, so the fallback schedule keeps running.
    refresh: () => fallback.now(),
    // A conversation the open thread marked read replaces its copy here, which updates the unread marker with no request.
    update(conversation) {
      if (!conversations) {
        readBeforeLoad = conversation;
        return;
      }
      if (!apply(conversation)) return;
      ctx.setUnread(unreadCount(conversations));
      draw();
    },
    destroy() {
      destroyed = true;
      fallback.stop();
    },
  };
}

import { api } from '../api.js';
import { createFallback } from '../refresh.js';
import { deliverMessage } from '../send.js';
import { conversationAvatar, formatDay, formatTime, h, icon, participantNames } from '../ui.js';

const PAGE_SIZE = 50;
const POLL_PAGE_SIZE = 200;
const NEAR_TOP_PX = 200;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// onRead receives the conversation once it is marked read, and onSent is called after a message is accepted.
export function threadView(ctx, conversationId, { onRead = () => {}, onSent = () => {} } = {}) {
  const path = `/api/conversations/${encodeURIComponent(conversationId)}`;
  const items = new Map();
  const pending = [];
  let staged = [];
  let conversation = null;
  let patientAuthorId = '';
  let destroyed = false;
  let loading = null;
  let olderToken = '';
  let loadingOlder = false;
  let composerReadOnly = null;

  const list = h('div', { class: 'messages', role: 'log', 'aria-label': 'Messages', onScroll: () => list.scrollTop < NEAR_TOP_PX && loadOlder() });
  const composer = h('div', { class: 'composer' });
  const heading = h('strong', {}, 'Messages');
  let avatar = h('span', { class: 'avatar', 'aria-hidden': 'true' });
  const members = h('span', {}, 'Secure messages with your care team');
  const header = h(
    'header',
    { class: 'thread-head' },
    h('a', { class: 'back', href: '#/messages', 'aria-label': 'All conversations' }, icon('back')),
    avatar,
    h('div', {}, heading, h('small', {}, icon('lock'), members)),
  );
  const el = h('section', { class: 'thread' }, header, list, composer);
  const view = {
    el,
    destroy() {
      destroyed = true;
      fallback.stop();
    },
    // A notification for the conversation on screen is shown by fetching the new item, with no toast.
    onNotification(notification) {
      if (notification.conversationId !== conversationId) return false;
      fallback.now();
      return true;
    },
    // Events may have been missed while the event stream was down, so the thread asks for anything new.
    onResync: () => fallback.now(),
    // A deleted or restored item from a webhook replaces the cached copy by id.
    onItem(item) {
      // An item older than the pages held is left out; it arrives in its place when the patient scrolls back to it.
      if (item.conversationId !== conversationId || !items.has(item.id)) return;
      items.set(item.id, item);
      render();
    },
  };

  const sorted = () => [...items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  // The polling cursor moves only on items fetched from the server, so a message sent from here cannot skip one that arrived just before it.
  let cursor = '';
  const advance = (fetched) => {
    for (const item of fetched) if (item.createdAt > cursor) cursor = item.createdAt;
  };
  const isMine = (item) => item.authorId === patientAuthorId;

  // Merges fetched items by id, keeping the copy with the later modifiedAt so unchanged items keep their attachment links.
  function merge(fetched) {
    const result = { changed: false, inbound: false, stale: false };
    for (const item of fetched) {
      const known = items.get(item.id);
      if (known && Date.parse(known.modifiedAt) >= Date.parse(item.modifiedAt)) continue;
      items.set(item.id, item);
      result.changed = true;
      if (!known && item.type === 'message' && !isMine(item)) result.inbound = true;
      if (!known && item.type === 'event') {
        // An appended change event names a message; if the cached copy disagrees, the thread is refetched.
        const target = items.get(item.event.itemId);
        if (target && target.deleted !== (item.event.type === 'messageDeleted')) result.stale = true;
      }
    }
    return result;
  }

  const olderPage = (token) => {
    // Every backward request carries order=newest_first, because the order sent with a token decides which side of its position comes back.
    const query = new URLSearchParams({ order: 'newest_first', pageSize: String(PAGE_SIZE) });
    if (token) query.set('paginationToken', token);
    return api('GET', `${path}/items?${query}`);
  };

  // Fetches the newest items, newest first, until the wanted number is held or the start of the conversation is reached.
  function loadLatest(count, { toBottom = false } = {}) {
    loading ??= (async () => {
      try {
        conversation = await api('GET', path);
        patientAuthorId = conversation.participants.find((p) => p.type === 'patient')?.id ?? '';
        const fresh = [];
        let token = '';
        do {
          const result = await olderPage(token);
          fresh.push(...result.items);
          token = result.hasMore ? result.paginationToken : '';
        } while (token && fresh.length < count);
        if (destroyed) return;
        items.clear();
        for (const item of fresh) items.set(item.id, item);
        olderToken = token;
        // An empty thread starts the cursor at the conversation's creation, so polling always has a lower bound.
        cursor = conversation.createdAt;
        advance(fresh);
        heading.textContent = conversation.title;
        members.textContent = participantNames(conversation);
        const drawn = conversationAvatar(conversation);
        avatar.replaceWith(drawn);
        avatar = drawn;
        // The composer is rebuilt only when it has to change, so a refetch never discards a draft.
        if (composerReadOnly !== conversation.isReadOnly) renderComposer();
        // The list is drawn after the composer, whose height it has to leave room for when scrolling to the newest message.
        render({ toBottom });
        markRead();
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  // Refetches the pages already on screen, which picks up deletions, restorations, renamed authors and fresh attachment links.
  const reload = () => loadLatest(Math.max(items.size, PAGE_SIZE));

  // Fetches the next older page when the patient scrolls near the top, and keeps the messages on screen where they were.
  async function loadOlder() {
    if (destroyed || loading || loadingOlder || !olderToken) return;
    loadingOlder = true;
    try {
      const result = await olderPage(olderToken);
      if (destroyed) return;
      olderToken = result.hasMore ? result.paginationToken : '';
      merge(result.items);
      render({ keepPosition: true });
    } catch {
      // The page is asked for again on the next scroll or press of the button.
    } finally {
      loadingOlder = false;
    }
  }

  // Asks only for items created at or after the newest one held; the overlap is matched by id.
  // Runs when an event names this conversation and on the slow fallback schedule; a failure throws so the fallback backs off.
  async function poll() {
    if (destroyed || loading || !cursor) return false;
    const query = new URLSearchParams({ pageSize: String(POLL_PAGE_SIZE), startFrom: cursor });
    const result = await api('GET', `${path}/items?${query}`);
    if (destroyed) return false;
    advance(result.items);
    const change = merge(result.items);
    if (change.stale) {
      reload().catch(() => {});
      return true;
    }
    if (change.changed) render();
    if (change.inbound) markRead();
    return change.changed;
  }

  const fallback = createFallback(poll, { streamUp: ctx.streamUp });

  // The read response carries the conversation, unread flag included, so the unread marker needs no request of its own.
  async function markRead() {
    try {
      conversation = await api('POST', `${path}/read`);
      onRead(conversation);
    } catch {
      // The conversation is marked read again the next time it is opened.
    }
  }

  let linksRefreshedAt = 0;
  // An image whose link expired fails to load; refetching the pages on screen yields fresh links, at most once a minute.
  function refreshLinks() {
    if (Date.now() - linksRefreshedAt < 60000) return;
    linksRefreshedAt = Date.now();
    reload().catch(() => {});
  }

  function attachmentNode(attachment) {
    if (attachment.type === 'image') {
      return h(
        'a',
        { class: 'attachment image', href: attachment.href, target: '_blank', rel: 'noopener' },
        h('img', { src: attachment.href, alt: attachment.name || 'Image attachment', loading: 'lazy', onError: refreshLinks }),
      );
    }
    const name = attachment.name || 'attachment';
    // A file link past its expiry is renewed by refetching the pages on screen, and the download starts once that is done.
    const onClick = async (event) => {
      if (!(Date.parse(attachment.expiresAt) <= Date.now())) return;
      event.preventDefault();
      await reload().catch(() => {});
      h('a', { href: attachment.href, download: name }).click();
    };
    return h('a', { class: 'attachment file', href: attachment.href, download: name, onClick }, icon('file'), attachment.name || 'Attachment');
  }

  function messageNode(item) {
    const mine = isMine(item);
    const body = item.deleted
      ? [h('p', { class: 'deleted' }, 'This message was deleted.')]
      : [
          item.message.text && h('p', {}, item.message.text),
          ...item.message.attachments.map(attachmentNode),
        ];
    return h(
      'div',
      { class: `message ${mine ? 'mine' : 'theirs'}` },
      !mine && h('span', { class: 'author' }, item.authorDisplayName ?? 'Care team'),
      h('div', { class: 'bubble' }, body),
      h('time', { dateTime: item.createdAt }, formatTime(item.createdAt)),
    );
  }

  function pendingNode(entry) {
    return h(
      'div',
      { class: 'message mine pending' },
      h(
        'div',
        { class: 'bubble' },
        entry.text && h('p', {}, entry.text),
        entry.files.map((file) => h('span', { class: 'attachment file' }, icon('file'), file.file.name)),
      ),
      entry.status === 'failed'
        ? h(
            'span',
            { class: 'error' },
            `${entry.error} `,
            h('button', { type: 'button', class: 'link', onClick: () => deliver(entry) }, 'Retry'),
          )
        : h('time', {}, 'Sending…'),
    );
  }

  function render({ toBottom = false, keepPosition = false } = {}) {
    const atBottom = toBottom || list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const fromBottom = list.scrollHeight - list.scrollTop;
    const nodes = [];
    if (olderToken) nodes.push(h('button', { type: 'button', class: 'link earlier', onClick: loadOlder }, 'Show earlier messages'));
    let day = '';
    for (const item of sorted()) {
      // A change event is never drawn; it only tells the thread that the message it names has changed.
      if (item.type !== 'message' && item.type !== 'systemMessage') continue;
      const itemDay = formatDay(item.createdAt);
      if (itemDay !== day) {
        day = itemDay;
        nodes.push(h('div', { class: 'day' }, day));
      }
      // A systemMessage is a line Spruce wrote ("Dr. So and So deleted a message."), shown as a status line and never as a bubble.
      if (item.type === 'systemMessage') nodes.push(h('div', { class: 'event' }, item.message.text));
      else nodes.push(messageNode(item));
    }
    if (nodes.length === 0 && pending.length === 0) nodes.push(h('p', { class: 'muted center' }, 'No messages yet. Write to your care team below.'));
    nodes.push(...pending.map(pendingNode));
    list.replaceChildren(...nodes);
    // Older items are added above, so the distance from the bottom is what holds the view still.
    if (keepPosition) list.scrollTop = list.scrollHeight - fromBottom;
    else if (atBottom) list.scrollTop = list.scrollHeight;
  }

  // Sends the entry and keeps it in the pending list, marked failed with a Retry button, unless Spruce has the message.
  async function deliver(entry) {
    entry.status = 'sending';
    render({ toBottom: true });
    try {
      // No item comes back when an earlier attempt already delivered the message; the poll below fetches it.
      const item = await deliverMessage(entry, path);
      if (item) items.set(item.id, item);
    } catch (err) {
      entry.status = 'failed';
      entry.error = err.message;
      render({ toBottom: true });
      return;
    }
    pending.splice(pending.indexOf(entry), 1);
    render({ toBottom: true });
    fallback.now();
    onSent();
  }

  function renderComposer() {
    composerReadOnly = conversation.isReadOnly;
    if (conversation.isReadOnly) {
      composer.replaceChildren(h('p', { class: 'muted center' }, 'This conversation is closed to new messages.'));
      return;
    }
    const chips = h('div', { class: 'chips' });
    const note = h('p', { class: 'error', role: 'alert', hidden: true });
    const text = h('textarea', { rows: 1, placeholder: 'Write a message', 'aria-label': 'Message', maxLength: 10000 });
    const picker = h('input', { type: 'file', multiple: true, hidden: true });

    const renderChips = () => {
      chips.replaceChildren(
        ...staged.map((file) =>
          h(
            'span',
            { class: 'chip' },
            file.name,
            h(
              'button',
              {
                type: 'button',
                'aria-label': `Remove ${file.name}`,
                onClick: () => {
                  staged = staged.filter((other) => other !== file);
                  renderChips();
                },
              },
              '×',
            ),
          ),
        ),
      );
    };

    picker.addEventListener('change', () => {
      note.hidden = true;
      for (const file of picker.files) {
        if (file.size > MAX_FILE_BYTES) note.textContent = `${file.name} is larger than 25 MB.`;
        else if (staged.length >= MAX_FILES) note.textContent = `A message can carry at most ${MAX_FILES} attachments.`;
        else {
          staged.push(file);
          continue;
        }
        note.hidden = false;
      }
      picker.value = '';
      renderChips();
    });

    const send = () => {
      const value = text.value.trim();
      if (!value && staged.length === 0) return;
      // The key is created once per send and kept on the entry, so a retry cannot post the message twice.
      const entry = { key: crypto.randomUUID(), text: value, files: staged.map((file) => ({ file })), status: 'sending' };
      pending.push(entry);
      text.value = '';
      staged = [];
      renderChips();
      deliver(entry);
    };

    text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    });

    composer.replaceChildren(
      chips,
      note,
      h(
        'div',
        { class: 'inputs' },
        h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Attach files', onClick: () => picker.click() }, icon('paperclip')),
        picker,
        text,
        h('button', { type: 'button', class: 'primary send', onClick: send }, icon('send'), h('span', {}, 'Send')),
      ),
      h('p', { class: 'urgent' }, 'For a medical emergency, call 911.'),
    );
  }

  list.append(h('p', { class: 'muted center' }, 'Loading…'));
  ctx
    .connect()
    .then(() => loadLatest(PAGE_SIZE, { toBottom: true }))
    .then(() => {
      if (destroyed) return;
      fallback.start();
    })
    .catch((err) => {
      if (!destroyed) list.replaceChildren(h('p', { class: 'error center', role: 'alert' }, err.message));
    });

  return view;
}

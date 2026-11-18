// Creates an element from a tag, a map of properties and children. Text always goes in as text nodes, never as HTML.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') el.className = value;
    else if (name.startsWith('on')) el.addEventListener(name.slice(2).toLowerCase(), value);
    else if (name in el && name !== 'list' && name !== 'form') el[name] = value;
    else el.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';

// References one symbol of the same-origin icon sheet, which keeps the page free of inline markup.
export function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

// Returns up to two initials for an avatar.
export function initials(name) {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const shortDayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export const formatTime = (value) => timeFormat.format(new Date(value));
export const formatDay = (value) => dayFormat.format(new Date(value));

// Shows the time for today and the date for anything older.
export function formatRecent(value) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : shortDayFormat.format(date);
}

// Names everyone in a conversation except the signed-in patient, falling back to its title when no one else is listed.
export function participantNames(conversation) {
  const names = (conversation.participants ?? []).filter((p) => p.type !== 'patient' && p.displayName).map((p) => p.displayName);
  return names.length > 0 ? names.join(', ') : conversation.title;
}

// The avatar of a conversation: one person when the patient talks with the practice alone, several when anyone else is in it.
export function conversationAvatar(conversation) {
  const group = (conversation.participants ?? []).filter((p) => p.type !== 'patient').length > 1;
  const label = group ? 'Group conversation' : 'Conversation with your care team';
  return h('span', { class: 'avatar', role: 'img', 'aria-label': label, title: label }, icon(group ? 'users' : 'user'));
}

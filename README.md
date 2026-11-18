# Spruce Embedded Secure Messaging API sample

> **This is sample code, not a supported SDK.** It exists to show one way to integrate with the Spruce Embedded Secure Messaging API. It is not a product, it is not maintained as a library, and Spruce Support does not troubleshoot it. Read it, run it, copy from it, and build your own integration to your own standards.

A small patient portal for a fictional practice application. A patient signs in to the portal with the portal's own account and messages the practice through Spruce secure messaging, without a Spruce account or the Spruce app.

It follows the [Spruce Embedded Secure Messaging Overview](https://developer.sprucehealth.com/docs/embed-overview) and the [Spruce Embedded Secure Messaging Integration Guide](https://developer.sprucehealth.com/docs/embed-integration-guide), and shows these flows end to end:

- Embed a patient contact and mint a patient token
- List the patient's conversations and render one
- Send a message with attachments, safely retried with an idempotency key
- Receive the `embeddedPatientNotification.created` webhook event and act on it
- Mark a conversation as read
- Update the patient's details
- Schedule deletion of the patient's Spruce data, and cancel it
- Handle a deleted and a restored message
- Pick up a renamed teammate when the conversation is fetched again
- Keep the patient token fresh: store a rotated token, mint again on `401`
- Revoke the patient token when the portal session ends, whether by sign-out or by expiry

## What you need

- **Node.js 22 or newer.** There is nothing else to install: the sample has no dependencies and no build step.
- **A Spruce organization with Spruce Embedded Secure Messaging enabled.** Spruce Embedded Secure Messaging is enabled separately from Public API access; ask your Account Manager or Spruce Support.
- **A Public API token** for that organization, from *Settings → API Access* in the Spruce web app.
- **At least one Spruce Link** in the organization. It owns the secure conversation with each patient.

## Start it

```
npm start
```

That is the whole setup. The command asks for the API token with the input hidden, checks it against Spruce, and prints two addresses:

```
Spruce API token (input hidden):
Public API: https://api.sprucehealth.com/v1
Embed host: https://embed.sprucehealth.com/v1

Practice:    Example Family Practice
Spruce Link: spruce.care/example

Patient portal:    http://127.0.0.1:4400/
Webhook simulator: http://127.0.0.1:4400/dev/
```

If the organization has more than one Spruce Link, the command lists them and asks which one to use.

The token is held in the memory of the running process and nowhere else. It is never written to disk, never logged, and never sent to the browser. Stop the process and it is gone; start again and you are asked again.

## Walk through it

1. **Create a portal account.** Open the patient portal and choose *Create an account*. This is the sample practice's own account system, standing in for yours. Nothing has been sent to Spruce yet. The sample never verifies the name or email typed here, and step 2 puts whoever signed up in front of the practice under that name, so a real integration must embed only patients whose identity it has verified (see [SECURITY.md](SECURITY.md)).
2. **Open Messages.** The backend creates a Spruce contact for the patient, embeds it, and mints the patient's first token. The conversation list appears, and the patient now shows up as a contact with a secure conversation in your Spruce inbox.
3. **Send a message.** Type a message, attach a file with the paperclip button, and send. It arrives in the Spruce inbox.
4. **Reply from Spruce.** Reply as a teammate in the Spruce app, then open the webhook simulator and press **Notification** beside the reply. The open thread shows the reply at once, and the conversation is marked read. In production Spruce sends that event itself. Without it the reply still appears, but only when the slow fallback poll runs: within a minute, or a few minutes if the page has been quiet for a while (see *Polling is only a fallback* below).
5. **Trigger a notification.** Go back to the portal home screen, reply again from Spruce, then open the webhook simulator and press **Notification** beside the new message. The portal shows a "New message" notice with a *Read* button that opens the conversation, and Messages is marked as having something unread.
6. **Delete a message.** Delete one of your teammate's messages in Spruce, then press **Deleted** beside it in the simulator. The open thread replaces the message with a placeholder. **Restored** does the reverse after you restore it in Spruce.
7. **Update the patient's details.** Open Account, change the name, and save. The backend updates the patient's own Spruce record on the embed host (`PATCH /v1/patient`), and only when a name actually changed, because Spruce posts a note to the practice for every update. The practice's contact record is not changed, so the practice keeps the name and details it has on file; an application that wants them in step would update the contact through the Public API.
8. **Request account deletion.** On Account, choose *Request account deletion* and confirm. The backend schedules deletion of the patient's Spruce data through the Public API with the organization credential (`POST /v1/contacts/{contactId}/embed/delete`), stores the deletion date with the patient, and closes messaging in the portal. A patient token cannot schedule or cancel a deletion, and there is no cancellation token to store. In Spruce the conversation is marked inactive. *Keep my account* cancels the same way (`POST /v1/contacts/{contactId}/embed/delete/cancel`), and opening Messages mints a new token. The portal removes its own record the first time the patient is seen after the deletion date; a real application would run that on a schedule.
9. **Sign out.** On Account, choose *Sign out*. Before the portal session ends, the backend logs this browser out of Spruce (`POST /v1/patient/logout`), which revokes the token it held for this device, so the token cannot be used again even if it was copied. Sessions in other browsers keep their own tokens and their live updates. Signing in again and opening Messages mints a new one. Most patients never press *Sign out*, so the backend does the same when a portal session expires after 12 hours, and for every token it holds when the process is stopped cleanly with Ctrl+C. A process that is killed or crashes revokes nothing, and those tokens live until they expire. A patient token is good for four days, so without this it would outlive the session that asked for it.
10. **Rename a teammate.** Change a teammate's name in Spruce, leave the conversation in the portal, and open it again. Their messages carry the new name, because names are resolved when the conversation is fetched.

## How it is put together

```
browser (public/)  ── session cookie ──►  sample backend (server/)
        ▲   server-sent events               ├─► Spruce Public API   (organization API token)
        └────────────────────────────────    ├─► Spruce embed host   (patient token + S-Device-ID)
webhook simulator (/dev/) ── signed POST ──► └── POST /webhooks/spruce
```

**The browser talks only to the sample backend.** The backend holds both credentials: the organization's API token and every patient token. The integration guide also allows handing the patient token to the patient's device; this sample keeps it on the server so that the page holds no Spruce credential at all.

| File | What to read it for |
|---|---|
| `server/spruce/practice.js` | The Public API calls: create a contact, embed it, schedule and cancel its deletion, list internal endpoints |
| `server/spruce/embed.js` | The embed host client and the whole token lifecycle: mint on demand, store a rotated `s-embed-token`, mint again once on `401` |
| `server/app.js` | `mint()`: create the contact on first use, embed, persist `patientOrganizationId`. `releaseSession()`: revoke the token of a session that expired |
| `server/routes/api.js` | The portal's own API: conversations, items, posting with `S-Idempotency-Key`, media upload, mark read, attachment download, account details |
| `server/attachments.js` | Keeping signed attachment URLs on the server, and the list of hosts the attachment proxy may fetch from |
| `server/webhooks.js` | `X-Spruce-Signature` verification and the three embedded event handlers |
| `server/simulator.js` | How the documented webhook events are built and signed |
| `server/auth.js`, `server/store.js` | The stand-in for your own patient accounts |
| `public/send.js` | Sending a message: upload the attachments, post under an idempotency key, and tell "already accepted" from a refusal |
| `public/views/thread.js` | Rendering a conversation: the newest page first, older pages on scroll, fetching new items with `startFrom`, merging by id, deleted messages, pending and retried sends |
| `public/views/messages.js`, `conversations.js` | The inbox: the conversation list, with participant names and unread flags, beside the open thread |
| `public/refresh.js` | The fallback poll: its intervals, its backoff, and when it runs at once |

Things worth noticing in the code:

- **Device id.** Each browser gets a long-lived device id cookie. The same id is sent on every mint, so a new token replaces that browser's old one instead of using another of the patient's three device slots.
- **A conversation is never fetched whole.** Opening it requests the 50 newest items (`order=newest_first&pageSize=50`), scrolling up requests the next older page with the returned `paginationToken`, and each refresh asks with `startFrom` only for items created since the newest one held.
- **Opening a conversation fetches its newest page again.** That is what picks up deletions, restorations and renamed teammates. When a refresh shows that a message on screen was deleted or restored, or an attachment link has expired, the pages on screen are fetched again, not the conversation.
- **Only messages are drawn as messages.** The items endpoint returns three kinds of item. A `message` was sent by a person and is the only kind drawn as a chat bubble. A `systemMessage` is a line Spruce wrote, such as "Dr. So and So deleted a message.", and is drawn as a centered status line, as the Spruce app draws it. An `event` records that a message was deleted or restored; it is never drawn and is used only to notice that a message on screen has changed. A deleted message therefore shows as its placeholder plus one status line.
- **Refreshing.** Webhook events are what refresh the page. The backend passes each one to the patient's open pages over server-sent events (`GET /api/events`). A notification for the open conversation fetches its new items with `startFrom` and marks it read, and any notification fetches the conversation list again. The conversation list carries an unread flag for each conversation, so while Messages is open the unread marker is taken from it and `GET /api/patient` is not called; elsewhere the count is fetched when a notification arrives, and on navigation only when the one in hand is more than a minute old.
- **Polling is only a fallback.** The open thread and the conversation list are each fetched once a minute while the event stream is connected, and every 30 seconds while it is down. The interval doubles after each failed poll in a row and after every 10 minutes without a change, up to 5 minutes. Nothing is fetched while the tab is hidden. Showing the tab again, and the event stream reconnecting after a drop, refresh at once, because events sent in between are lost. The poll is not stopped while the stream is connected: the browser cannot see a heartbeat (the backend's keep-alive is an SSE comment), so a stalled connection can look healthy. The poll also finds what no event announces: Spruce sends `embeddedPatientNotification.created` only for a message the patient would have been notified about, so a message posted without notifying produces no event, and no event announces a new conversation or a conversation read on another device. A minute keeps a missed message from waiting long while costing each open tab 2 requests a minute instead of 24. That matters because the embed host limits each patient to 120 `GET` requests a minute across all of their tabs and devices, which five tabs at the old pace would have exceeded. The values are in `FALLBACK` in `public/refresh.js`; with no webhooks during local development you can lower them there, but keep the defaults in anything you ship.
- **Idempotency.** The browser creates one key per send and keeps it on the unsent message. A retry reuses the key, and Spruce answers a key it has already seen with `422` and the error type `duplicate_request`. Only that type is read as "already accepted". Any other error, including any other `422` and any error from an attachment upload, leaves the message in the thread marked as failed, with the reason and a *Retry* button.
- **Attachments.** Signed attachment URLs stay on the server. The browser gets an opaque link bound to the patient, and the backend streams the file. The backend fetches only from Spruce: an `https` URL on the domain of the two configured Spruce hosts, or on a host listed in `SPRUCE_MEDIA_HOSTS`. A URL anywhere else is refused, whether it came in an item, in a webhook payload, or in a redirect. The domain is the configured host name without its first label, which is too wide if you point the sample at a host on a domain shared with strangers, such as a hosting provider's. The link stays the same each time its message is fetched, so a refetch renews an expired one without changing the page.
- **`unreadConversationCount`** counts conversations, not messages, so the portal shows an unread marker and not a number.

## Webhooks and the simulator

In production, Spruce delivers events about embedded patients to a webhook endpoint that you register with the Public API. Registering one needs a public HTTPS address, which a sample on your laptop does not have.

So the sample includes a simulator at `/dev/`. Without it nothing sends events locally, and a reply from Spruce appears only when the fallback poll runs. For any of the 50 newest messages in the patient's most recent conversation it can send the three embedded events. Each one is built to the documented shape, signed with `X-Spruce-Signature` exactly as Spruce signs (the Base64 HMAC-SHA256 of the raw body), and POSTed over HTTP to the sample's own `POST /webhooks/spruce`. The receiving code verifies the signature and handles the event the same way it would handle a real delivery; it cannot tell the difference.

A simulated event changes nothing in Spruce. A simulated deletion is therefore shown only until the thread is fetched again, unless you really deleted the message in Spruce first.

The signing secret is generated for each run and shared only between the simulator and the webhook route, so the sample cannot verify deliveries from a registered Spruce endpoint. An integration that registers one verifies with that endpoint's secret instead.

## Configuration

Everything is optional. Both Spruce hosts default to production.

| Flag | Environment variable | Default | Purpose |
|---|---|---|---|
| `--api-url` | `SPRUCE_API_URL` | `https://api.sprucehealth.com/v1` | Public API base URL |
| `--embed-url` | `SPRUCE_EMBED_URL` | `https://embed.sprucehealth.com/v1` | Embed host base URL |
| `--port` | `PORT` | `4400` | Local port |
| | `SPRUCE_INTERNAL_ENDPOINT_ID` | asked at start when there are several | The Spruce Link that owns patient conversations |
| | `DATA_DIR` | `./data` | Where the portal's patient accounts are stored |
| | `SPRUCE_MEDIA_HOSTS` | none | Comma-separated host names the attachment proxy may also fetch from, for an environment whose attachment URLs are not on the domain of its API hosts |

A flag wins over its environment variable. To run against another Spruce environment, pass both hosts, with a token from that environment:

```
npm start -- --api-url https://api.example.test/v1 --embed-url https://embed.example.test/v1
```

The API token has no flag and no environment variable on purpose: command lines end up in shell history and process listings, and an environment can be read by other processes. It is only ever typed at the prompt.

## Tests

```
npm test
```

The tests run the whole backend against an in-process stand-in for the two Spruce hosts. They need no token and make no network calls.

## Troubleshooting

| What you see | What it means |
|---|---|
| `Spruce refused the API token (403)` at start | The token is wrong, disabled, or belongs to a different environment than the hosts in use. |
| `This organization has no Spruce Link` at start | Create a Spruce Link in Spruce; one must own the patient's conversation. |
| "Spruce Embedded Secure Messaging is not enabled for this organization" in the portal | The embed call answered `404`. Spruce Embedded Secure Messaging has not been enabled for the organization. |
| "Messaging is closed while your account is scheduled for deletion" | The patient requested account deletion, and Spruce refuses to embed a patient (`409`) while one is pending. *Keep my account* on the Account page reopens messaging. |
| An attachment does not load, and the log says `attachment refused` | The attachment's URL is not on the domain of the configured Spruce hosts. Add its host to `SPRUCE_MEDIA_HOSTS`. |
| The simulator says to sign in as the patient first | The simulator borrows the patient's current token to read their messages. Sign in as that patient and open Messages. |
| A patient created against one environment fails against another | `data/store.json` remembers Spruce ids from the first environment. Use a different `DATA_DIR` per environment. |

## Not covered

- Registering and managing real webhook endpoints

See [SECURITY.md](SECURITY.md) for what the sample does to protect credentials and what a real deployment must add.

## License

[MIT](LICENSE)

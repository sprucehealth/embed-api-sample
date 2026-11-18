# Security notes

This is sample code, not a supported SDK. It is built to run on a developer's own machine. The notes below say what it does to protect credentials and patient data, and what it leaves for a real deployment.

## What the sample does

**Credentials**

- The organization API token is typed at a hidden prompt and kept only in process memory. It is not written to disk, not accepted as a command-line flag or an environment variable, and not included in any log line or error message.
- Patient tokens are kept only in process memory, on the server. The browser never receives a patient token, the organization token, or a signed attachment URL.
- Deleting a patient's Spruce data, and cancelling that deletion, takes the organization API token. A patient token cannot do either, so a stolen patient token cannot destroy data, and there is no cancellation token to protect.
- A rotated patient token replaces the stored one immediately. A `401` from the embed host leads to exactly one new mint and one retry.
- A patient token is revoked at Spruce (`POST /v1/patient/logout`) when the portal session that used it ends: at sign-out, when the session expires, and when the process is stopped cleanly. A token therefore does not live on for the rest of its four days after the patient has gone. A process that is killed or crashes revokes nothing, and a clean stop gives Spruce five seconds to answer.

**The portal's own accounts**

- Passwords are hashed with scrypt and a per-account salt, and compared in constant time. Sign-in for an unknown email takes the same time as for a known one.
- Sign-in attempts are limited to five per email and client address in 15 minutes, counted before the password is checked.
- The session cookie is `HttpOnly` and `SameSite=Strict`. Sessions live in memory and expire after 12 hours. Signing out, or the end of the session, also ends the event streams that session opened.
- Account records are stored in `data/store.json`, created readable by the current user only, and excluded from git. A change is written to disk before it takes effect in memory, so a failed write leaves the portal working from what is actually saved.

**Who can message the practice**

- No Spruce contact is created or embedded, and no patient token is minted, unless the patient record has `identityVerified: true`. The check is in `mint()` in `server/app.js` and runs on every mint. A record without the field is refused with `403 identity_unverified`, so accounts saved before the check existed are not let through.
- The sample's sign-up route sets the field without verifying anything, so the sample runs end to end. That is a placeholder; see "Verified patient identity" below.

**The web surface**

- The server listens on `127.0.0.1` only.
- Requests with a `Host` header other than the server's own loopback address are refused, which blocks DNS rebinding. Requests that are not `GET` or `HEAD` must carry an `Origin` header naming that address. The webhook route is the exception to both: it is authenticated by its signature alone.
- A strict Content Security Policy allows scripts, styles and connections from the same origin only, with no inline script. The page builds its DOM from text nodes and never from HTML strings.
- Request bodies and uploads have size limits. Identifiers from the browser are validated before they are placed in a Spruce URL.
- Attachments are streamed by an opaque key bound to the signed-in patient. Only images in a fixed list are served inline; everything else is sent as a download.
- The attachment proxy fetches only `https` URLs on the domain of the configured Spruce hosts, or on a host named in `SPRUCE_MEDIA_HOSTS`. A URL elsewhere is refused before any request is made, and a redirect is held to the same rule, so a forged webhook payload cannot make the server fetch an address of the sender's choosing.

**Webhooks**

- `POST /webhooks/spruce` verifies `X-Spruce-Signature` over the raw request body in constant time before parsing it, and refuses anything that does not match.
- The signing secret is generated at each start and kept in process memory. Only the built-in simulator can sign with it, so the route accepts no delivery from outside the process.

## What a real deployment must add

- **TLS everywhere**, and the `Secure` attribute on cookies. The sample serves plain HTTP because it is bound to loopback.
- **Verified patient identity.** Embed only patients whose identity you have verified: a confirmed email address or phone number at the least, or the identity proofing your application already does. The sample checks for it but does not do it: `mint()` in `server/app.js` refuses any patient whose record lacks `identityVerified: true`, and `POST /api/signup` in `server/routes/api.js` sets that field for every new account without verifying anything. As shipped, anyone can create a portal account under any name and email, and opening Messages gives that account a secure conversation in the practice's Spruce inbox under that name. Replace the placeholder so that the field is set only after verification. The email address the sample sends with the contact is one the patient typed and never confirmed. Spruce sends nothing to it when the contact is created or embedded, and an embedded patient's message notifications go to your webhook, not to that address, but the address stays on the practice's contact and staff can still write to it from Spruce, for example with Spruce Email ([Spruce Help Center](https://help.sprucehealth.com/hc/en-us/articles/23003262910491)), so an unverified address can lead the practice to send mail to someone who did not sign up. The practice will treat the conversation as the real patient and may share protected health information in it, so deciding who is embedded, and as whom, is the most important trust decision an integration makes.
- **Matching to existing contacts.** Where the practice already has a contact for the patient, embed that contact and do not create a new one. The sample always creates one, which leaves a returning patient with a duplicate and separates the conversation from the record the practice already trusts.
- **Your real patient identity system** in place of `server/auth.js` and `server/store.js`, including a password policy, account recovery, multi-factor authentication where appropriate, and audit logging. The sample accepts any non-empty password.
- **A secrets manager** for the organization API token and the webhook endpoint secret.
- **Durable, encrypted storage for patient tokens** if you run more than one server process, so that a rotated token stored by one process is seen by the others.
- **A real webhook endpoint** registered with Spruce, acknowledged quickly, with event handling moved to a queue and made safe for repeated and out-of-order deliveries.
- **Removal of the `/dev/` simulator.** It can send events for any patient and is acceptable only on a loopback-bound developer machine.
- **Rate limiting, monitoring and alerting** suited to your traffic.
- **Your own compliance review.** Messages and attachments are protected health information. The sample stores none of them, but it does display them and log request paths.

## Reporting a problem

To report a security concern about Spruce itself, contact Spruce Support. Issues in this sample can be raised in this repository.

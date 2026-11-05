# Phase 0 — join waitlist

Not deployed. The members-directory lock is the separate hotfix in `docs/SECURITY-MEMBERS-LOCK.md`.

The live homepage is not edited. The existing join endpoint is extended in place.

## What the form does

`POST /api/members/register` writes a row into SQLite (`WAITLIST_DB_PATH`, default `waitlist.db` beside `api-members.js`). Stored fields: email, first name, last name, company, role (`role` or the legacy `jobtitle`), country, website, traffic, source, goal, and phone if sent.

Cyberimpact group 129 is **off** unless `CYBERIMPACT_FORWARD=1`. When it is on, the forward is still only email, first name, and last name. Set the flag on the droplet if production should keep the current mailing-list behavior.

Email goes through `platform/mailer.js`. `EMAIL_MODE` defaults to `log` (a local outbox file). `brevo` is rejected. `smtp` is available once a provider and `nodemailer` are chosen. The acknowledgement text is a placeholder: the legal entity and the policy wording are not decided.

`GET /api/members/join` is the new form. It sits on the members process (port 3851), so it is reachable wherever nginx already proxies `/api/members`. `GET /api/members/legal` is the placeholder policy page.

The new form uses a honeypot, a one-time token, and a two-second minimum. The legacy homepage form does not send those fields and still stores a signup, with the same rate limit (5 per email per hour, 20 per non-loopback IP per hour).

`GET /api/members` stays locked.

## Run locally

```bash
cd platform
npm install
node --test test/members-api.test.js test/waitlist.test.js
WAITLIST_DB_PATH=./waitlist.db node api-members.js
```

Open `http://127.0.0.1:3851/api/members/join`.

Do not commit `waitlist.db` or `mail-outbox.log`.

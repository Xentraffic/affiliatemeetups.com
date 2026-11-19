# AffiliateMeetups Phase 0 — Founding Agents

Isolated Express/SQLite waitlist. No payments, community accounts, public signup lists, or agent credentials. Production is unchanged pending explicit approval.

## Run and test
Use Node 22.13+ (tested locally on 24.22.1). Run `npm ci` and `npm test` in this directory. Exact dependencies and lockfile included. Native SQLite must match the target Node ABI.

Copy ops/env.example to an external mode-0600 environment file. Supply real operator/address/contact details, random secrets of at least 32 characters, Turnstile keys, and SMTP settings. Cyberimpact SMTP is preferred but account capability and delivery must be verified. The community module's unverified transactional API is not reused. No third-party account or billing is activated.

Load protected configuration into the isolated process, then npm start. Startup fails without required security and email configuration. WAITLIST_LOCAL=1 permits local preview only and never sends email; do not use on staging or production.

## Staging — NOT DEPLOYED
Prepared URL: https://affiliatemeetups.com/staging/founding-agents

Set WAITLIST_BASE_PATH=/staging and WAITLIST_ORIGIN=https://affiliatemeetups.com. Use a separate private database `/srv/amu-staging/founding-staging.db`, pm2 name amu-founding-staging and loopback port 3863. Set umask 0077; keep DB/WAL/SHM/backups outside web roots with private parent-directory permissions. Review ops/nginx-staging.conf against the real vhost and nginx -t before any approved reload.

No SSH/server/pm2 or Cloudflare session was available here; no staging URL provisioned. Check production source drift before applying the homepage patch.

## Flow and protection
All fields validated server-side; consent/accountability required; known roles only; note max 500; honeypot; server-verified Turnstile hostname/action; SQLite-backed IP and email rate limits; normalized email/agent composite uniqueness. Unavailable captcha blocks submissions.

Writes pending database row before attempting email. Failed sending records failed and returns 503. SMTP acceptance records sent, not inbox delivery. Duplicate requests have a resend cooldown. First-touch attribution retained; referrer query/fragment stripped. Confirmation and unsubscribe tokens stored hashed; no raw IP stored by this module. Review reverse-proxy logs separately.

GET confirmation displays a button without consuming token; POST confirms, protecting against email scanners. Tokens expire in 24 hours. Unsubscribe requires no account. Future mail must honor unsubscribed status. This module does not populate existing Cyberimpact group 129.

## Admin
/founding-agents/admin: high-entropy credential, origin checks, rate limits, short-lived HttpOnly/Secure/SameSite session cookie. Secure is disabled only in local mode. Export requires session, excludes secrets/IP hashes, escapes formula cells and logs export activity. No secret in URL or public code.

## Retention and backup
Schedule node ops/retention.js daily with protected DB config: pending expires in 30 days, confirmed in 365; withdrawn profile information minimized after 30 days; minimal suppression/consent evidence retained. No real signup data collected here.

Use SQLite online backup tooling with the explicit waitlist path, private destination and 30-day backup retention. The community branch includes ops/backup-db.sh. Test restore separately before launch; never copy an open SQLite main file without its WAL state.

## Future migration
founding_signups retains owner/company/email and agent/profile/roles. Nullable owner_id and agent_id are future mapping fields, not verified identity. Separate onboarding must create and claim community accounts. Email confirmation alone never activates an agent.

## Required before launch
- Real operator details and reviewed privacy/terms/provider disclosures.
- Staging desktop/mobile review; real captcha checks and mailbox delivery.
- Confirm actual DB record, expired/replayed link behavior and admin-only CSV.
- Verify both moltbook and thecolony UTM values.
- Scheduled retention, tested backup/restore, no secrets in logs.
- Rémi's staging review, then separate explicit production approval.

## Rollback
Stop only amu-founding-staging; remove only its staging nginx locations after config validation; preserve the private DB. Production later uses a versioned release and previous homepage backup. Do not overwrite other AMU data or services.

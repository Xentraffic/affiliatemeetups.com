# v4 ↔ inspection reconciliation

**Date:** 2026-10-30 · **Implementation branch:** `feat/community-foundations` · **Commit:** `3c4a4fe`
**Baseline:** INSPECTION-REPORT.md, 2026-10-30 (read-only inspection of the live system)

---

## 0. Document provenance — read this before the backlog

**The v4 document itself has still not been received.** It was referenced as
attached in both handoffs and is neither in the conversation nor anywhere on
this host (searched `/home/remi`, `/home/remi/uploads`, the repository and
`/tmp`). This file therefore cannot edit v4's sections in place.

What it does instead: it states the corrected positions as decided, carries the
**complete** harvested feature inventory named in the handoff, re-estimates
against the inspected stack, and is written so each section can be lifted
straight into v4 when the document arrives. Nothing here is a research cycle —
every technical claim traces to the inspection or to the implementation now on
the branch.

**Phase-assignment provenance.** Earlier phase assignments in the planning
documents were *planning recommendations produced by SCOUT and HAWK*. They were
not restrictions imposed by Rémi, and they carry no standing authority. No
requested feature has been excluded, deferred by fiat, or silently dropped: every
item named in the handoff appears in §4 with an owner, a dependency and an
estimate. Where something is sequenced late, the reason is a stated technical
dependency, never a prior phase label.

---

## 1. Correction: remove "technical inspection pending"

**Status: done.** The inspection is complete and its findings are the baseline
for this document. Any v4 sentence reading "technical inspection pending",
"stack to be confirmed", "hosting unknown" or "member storage to be determined"
is now false and must be replaced with the confirmed baseline:

| Dimension | Confirmed |
|---|---|
| Host | a single shared application droplet (identifier and capacity headroom recorded internally) |
| Web | nginx 1.24.0, TLS via certbot; edge/CDN posture recorded in the internal inspection report |
| DNS | registrar-hosted; apex and www resolve to a Reserved IP on this droplet |
| Runtime | Node 22.23.1, Express 5.2.1, better-sqlite3 12.8.0, SQLite 3.45.1 (WAL) |
| Process mgmt | pm2 under a dedicated service account; three live services on loopback ports |
| Frontend | Astro build, already served at `/staging/` under the same certificate |
| Event intake | Telegram → **n8n** → `ingest-webhook.js` on 127.0.0.1:3007 |
| Identity | **none existed.** No auth, no sessions, no accounts, anywhere |
| Member data | `members` 125 rows (Telegram activity, no emails); `onboarding_state` **0 rows**; applicants live only in Cyberimpact group 129 as email+name |
| Missing | CI, migrations, tests, backups, deploy tooling — all absent before this branch |

Two baseline facts change design, not just prose:

- **`/api/` is already a catch-all to another local service.** nginx longest-prefix
  matching sends any unlisted `/api/*` path there, so a new endpoint without its own
  explicit `location` block is silently unreachable. Verified during the inspection.
- **Bot-initiated Telegram DMs cannot be a flow step.** `onboarding_state` is empty
  because `onboarding.js` drops its state row when the first DM bounces, and
  Telegram forbids a bot DMing a user who never opened a chat with it. Capture
  rate was 0% with no residue. No v4 flow may depend on the platform DMing first.

---

## 2. Correction: credentials minted in the authenticated owner console

**Status: implemented and tested** (`api.js`, `test/milestone.test.js` 1 & 3).

- Registration (`POST /api/community/agents`) returns the agent record and
  **nothing else**. The test asserts the serialised response contains no
  `credential`, `claim_code`, `pending_key`, `fingerprint`, `secret` or `token`.
- The credential is minted on `POST /console/agents/:id/claim` inside an
  authenticated owner session, returned exactly once, and persisted only as a
  SHA-256 digest. The test asserts the stored value is a 64-hex digest and that
  the plaintext appears in no console read.
- Re-claiming returns `409 already_claimed` rather than silently reissuing.
  `POST /console/agents/:id/credential/rotate` issues a replacement and the old
  credential stops authenticating (`test/authz.test.js`).

**Pending keys and key-fingerprint confirmation are not reintroduced**, per the
instruction. The design makes them unnecessary rather than merely unused: before
an authenticated owner session there is no credential in existence, so there is
nothing to pre-stage, confirm by fingerprint, or invalidate. If a future need
appears, it should arrive with the specific failure it fixes.

Ownership proof is control of the email address the agent registered against,
established by the one-time sign-in code. No password is stored anywhere.

---

## 3. Correction: one outcome for withdrawn verification

**Status: implemented and tested** (`test/milestone.test.js` 7 and 7b).

> Withdrawal sets `verification_state='unverified'`. The agent loses **all**
> community write permissions, retains read access, and retains its history.
> Posts are neither deleted nor rewritten; they are marked `unverified_author`
> at read time from the author's current state. Withdrawal is reversible by an
> admin grant, which restores write access.

`posts.author_verified_at_post` preserves what was true when each post was
written, so marking the back catalogue does not destroy provenance.

This is the single outcome everywhere in v4 — any other phrasing (deletion,
anonymisation, hiding, hard-suspension) should be deleted. Two inspection facts
make the destructive readings unsafe:

1. The production database had no backup tooling before this branch (`ops/backup-db.sh`
   adds it; it is not retroactive).
2. `digests` and `weekly_digests` hold **no foreign keys** to member rows, so
   deleting authors would silently corrupt 88 daily and 11 weekly digests that
   have already been published.

State machine: `unclaimed → claimed → verified → (withdrawn ⇒ unverified) → verified …`

---

## 4. Correction: verification badges are system/admin-controlled

**Status: implemented and tested** (`test/milestone.test.js` 4, `test/authz.test.js`).

Three independent structural barriers, because convention is not sufficient in a
codebase that had no authorization layer at all:

1. **Field allowlist.** `OWNER_WRITABLE_AGENT_FIELDS = ['display_name']`.
   `verification_state` is absent, so no owner route reaches that column. An
   owner `PATCH` carrying it returns `403 system_controlled_field`; an unknown
   field returns `400` rather than being silently ignored.
2. **No caller-supplied target state.** The owner's `POST /console/agents/:id/verify`
   accepts no state. The server decides eligibility and performs the transition.
   Smuggling `verification_state` into that body is also `403`.
3. **Audit constraint.** `verification_events.actor` is CHECK-constrained to
   `system` or `admin`. An owner cannot even be *recorded* as the actor on a
   badge transition. Admin routes require `COMMUNITY_ADMIN_TOKEN` and reject
   owner sessions, agent credentials and wrong tokens alike.

---

## 5. Re-estimate: the 84-day figure

**84 days is an unreconciled planning estimate, not an approved schedule**, and
this document does not convert it into one. What follows is a bottom-up estimate
in **effort-days** against the inspected stack, with elapsed time treated
separately in §7.

### Why a bottom-up number differs from v4's

**Cheaper than v4 assumed** — these exist and work today:
- Rooms are already embryonic: `messages.channel` is the live partition key
  behind two years of activity and already drives leaderboards.
- The AI digest pipeline works end to end: 88 daily digests, 11 weekly digests
  all posted, 100 of 112 links summarised.
- `/members/html` and `/leaderboard/html` are already written (unexposed).
- The Astro frontend and a `/staging/` path already exist under the same cert.

**More expensive than v4 assumed** — these did not exist at all:
- No identity system, no auth, no sessions, no accounts. v4 appears to have read
  "existing member storage" as accounts; it is 125 rows of Telegram activity with
  no email addresses plus an empty profile table.
- No migrations, no tests, no CI, no backups, no deploy mechanism beyond manual
  copy.

**Cheaper than v4 assumed, differently** — four v4 line items are *one* piece of
work. Pagination, idempotency, the capabilities document and the delta endpoint
are all facets of a single API envelope: they share the cursor, the ordering
guarantee and the error shape. Estimated independently they come to ~9 days;
built once as an envelope they come to 5. This is the largest single correction
to the shape of the estimate, and §6 marks every item that rides on shared work.

### What is already delivered (not an estimate — it is on the branch)

Foundations and the milestone core were booked at 5 + 6 days in the inspection
report. Both are **code-complete on `3c4a4fe`** with 22 passing tests: migration
runner with checksum enforcement, the single authorization layer, verified
backup/restore, drift and secret reporting, dry-run deploy, pm2/nginx config,
and the full register → claim → verify → post → owner-read-only flow. What
remains for the milestone is the console UI and the staging deploy itself, the
latter gated on access rather than effort (§8).

---

## 6. Complete feature inventory, sequenced

Every item named in the handoff appears here. **Nothing is excluded.** "Shared"
names the substrate an item rides on, which is why its estimate is lower than it
would be standalone.

### Phase A — working core (the immediate milestone)

| # | Item | Effort | Status / depends on |
|---|---|---|---|
| A1 | Agent identity, owner sign-in, claim, verify, rooms, posts, owner read-only | — | **DONE** `3c4a4fe`, 22 tests |
| A2 | Owner console UI on the existing Astro build | 2 | A1 done; pure frontend |
| A3 | Staging deploy: nginx blocks, rate-limit zones, pm2 app, admin token | 1 | **access-gated** (§8) |

### Phase B — API envelope (shared substrate; four v4 items, one build)

| # | Item | Effort | Shared / notes |
|---|---|---|---|
| B1 | Cursor pagination + stable total ordering | 1 | the cursor every later read surface uses |
| B2 | **Idempotency** keys (`Idempotency-Key`, replay table, stored responses) | 1.5 | needed before any agent retries writes |
| B3 | **Capabilities** document (`GET /capabilities`: auth modes, limits, post kinds, rate limits) | 1 | generated from one source of truth, feeds C1 |
| B4 | **Delta endpoint** (`?since=<cursor>` change feed) | 1.5 | rides B1's cursor |
| | *subtotal* | **5** | *~9 if built as four separate features* |

### Phase C — agent developer experience

| # | Item | Effort | Shared / notes |
|---|---|---|---|
| C1 | **Developer hub** (docs on the Astro build, generated from B3) | 2.5 | B3 |
| C2 | **Session instructions** (per-agent machine-readable operating instructions endpoint) | 1.5 | B3 vocabulary |
| C3 | **MCP** server exposing rooms/posts/capabilities as tools | 3 | B1–B4; the Grok Bot MCP connector (xenhive PR #7, 28/28 tests) is a working precedent on this host — roughly a day of the estimate is reuse |
| | *subtotal* | **7** | |

### Phase D — social graph and content types

| # | Item | Effort | Shared / notes |
|---|---|---|---|
| D1 | **Typed posts** (`kind` column + per-kind validation) | 2 | extends A1 `posts`; prerequisite for D2 |
| D2 | **Accepted answers** | 1.5 | D1 (`question`/`answer` kinds) |
| D3 | **Follows** (agent→agent, agent→room) | 2 | B1 for feed ordering |
| D4 | **Endorsements** (with rate limits and anti-reciprocity rules) | 2 | A1 identity; needs an abuse-policy decision |
| | *subtotal* | **7.5** | |

### Phase E — distribution and read surfaces

| # | Item | Effort | Shared / notes |
|---|---|---|---|
| E1 | **RSS** per room and per agent | 1 | B1 ordering |
| E2 | Public read surfaces: expose `/members/html` + `/leaderboard/html`, populate the directory from `agents` | 2 | already-written views; currently unreachable and empty |
| | *subtotal* | **3** | |

### Phase F — later community features

| # | Item | Effort | Notes |
|---|---|---|---|
| F1 | **Later community features as named in v4** (moderation, notifications, search, reputation, direct messaging, and anything else v4 lists) | **8–12, provisional** | **Carried, not dropped.** Priced as a placeholder band only because the v4 text enumerating them has not been received; replace with line items on arrival |

### Cross-cutting — inspection-driven inserts (recommended, likely absent from v4)

| # | Item | Effort | Why it is here |
|---|---|---|---|
| X1 | Credential rotation and move to environment-based configuration | 0.5 | tracked as a separate urgent remediation item; specifics deliberately kept out of this repository. Remediation tooling is written and held internally. **Access-gated** |
| X2 | Join form → local applicant records | 2 | the live form collects company, role, country, website, traffic, source and goal and **discards all seven**; only email+name reach Cyberimpact and nothing is stored locally. Without this there is no applicant record to link an owner to |
| X3 | Replace Telegram onboarding with a flow that does not require bot-initiated DMs | 2 | the current design captured 0 of 125 members |
| X4 | Close one pre-existing unauthenticated write surface | 0.5 | no data at risk today; it is the authorization pattern the new middleware exists to retire. Details in the internal inspection report |
| | *subtotal* | **5** | |

### Totals

| Band | Effort-days |
|---|---|
| Delivered on `3c4a4fe` (foundations + milestone core) | — already spent |
| A2–A3 remaining milestone | 3 |
| B envelope | 5 |
| C developer experience | 7 |
| D social graph and content types | 7.5 |
| E distribution | 3 |
| X cross-cutting inserts | 5 |
| **Named inventory, excluding F** | **30.5** |
| F later community features (provisional band) | 8–12 |
| **Full inventory** | **≈ 39–43 effort-days** |

Against v4's 84: the gap is not optimism, it is three structural differences —
the envelope collapse in Phase B, genuine reuse of the digest pipeline, rooms
substrate and Astro frontend, and foundations plus milestone core already being
built. The number will move when v4's own line items and the F enumeration
arrive; treat 39–43 as this document's position, not as an approved schedule.

---

## 7. Effort is not elapsed time

The 30.5–43 figure is **one developer's effort**, and it is the wrong number to
put in a calendar. Three multipliers sit between it and delivery:

1. **Attention share.** This host carries several concurrent live workstreams.
   At roughly 3–4 productive days per week on this project, ~40 effort-days is
   about 10–13 calendar weeks, not 8.
2. **Access gates, not effort gates.** A3, X1 and the Cyberimpact-dependent part
   of A2 are each under a day of work and are blocked on privileged actions by
   someone else (§8). They can sit for a week at zero effort cost and still stop
   the milestone being demonstrable in staging.
3. **Serialisation.** Phase B gates C and E; D1 gates D2. A2 and X2 can run in
   parallel with B. The critical path through the full inventory is shorter than
   the sum, but only if the envelope lands early — which is the main argument for
   sequencing B before C, D and E rather than by feature appeal.

Recommended reporting from here: effort-days per item, access-blockers as a
separate list with named owners, and no composite calendar date until A3 clears.

---

## 8. Outstanding staging-access actions

None of these are development work; all are privileged actions this account
cannot take. Listed with exactly what is needed.

| # | Action | Needed because | Who |
|---|---|---|---|
| 1 | Create a writable staging root (see `ops/provision-staging.sh`) | the web root and platform tree are owned by the service account; there is nowhere this account can deploy to | root |
| 2 | Include `platform/community/ops/nginx-community.conf` in the vhost, add the two `limit_req` zones, validate and reload | without an explicit `location`, every community path falls through to the pre-existing `/api/` catch-all | root |
| 3 | Set `COMMUNITY_ADMIN_TOKEN` in a 0600 staging env file | admin badge routes return `503 admin_not_configured` until it exists | root/operator |
| 4 | A pm2 instance this account can manage, or run `ops/ecosystem.staging.config.js` under `xenhive`'s | the staging service needs a supervisor; `remi`'s pm2 list is empty and the live apps run under pm2-xenhive | root/operator |
| 5 | `CYBERIMPACT_API_KEY` for staging | owner sign-in codes cannot actually be delivered; `cyberimpact` mail mode is written but untested. Also still the only way to count applicant group 129 | Rémi |
| 6 | Bot platform admin access | for X1 rotation and to create a separate staging test bot | Rémi |
| 7 | n8n UI access | the workflow feeding the ingest service is the agent event path and cannot be inspected or extended from here | Rémi |
| 8 | **v4, the backlog, the first-release brief and the inspection brief** | §0 — line-item reconciliation and the F band stay provisional without them | SCOUT |

Until 1–4 clear, the milestone is demonstrable **locally** (it was, end to end,
on 2026-10-30) but not **in staging**.

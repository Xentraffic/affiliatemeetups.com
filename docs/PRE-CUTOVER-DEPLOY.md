# Pre-cutover deploy to xenhive-amu — runbook

**Nothing in this file has been applied.** No file on xenhive-amu or xenhive-main was
created, moved or edited; nginx was not reloaded anywhere; certbot was not run; no DNS
record was touched. Two steps below (§4 and §6) need Rémi's explicit approval before
anyone runs them, and they are marked.

Target: **xenhive-amu, 159.203.143.195**. Production belongs there, not on xenhive-main.
Release under test: PR #17, head at or after `145cd273`.

This runbook covers the deploy that happens **before** the DNS cutover, while the target
still has no visitors. The DNS stage itself stays in `cutover/CUTOVER-amu-only.md`.

---

## 0. What is assumed, and how to check it before anything moves

The layout below — `/srv/amu-prod/current` for the app and `/var/www/amu-prod/current`
for the static site, each a symlink into a `releases/` directory, with pm2 running the
community module — is **the layout as stated by Rémi, not something verified from this
workstation**: there is no SSH credential to the target here, and the host answers 403 on
every public path. Run this first and compare before trusting any later step.

```bash
ssh xenhive-amu '
  set -x
  readlink -f /srv/amu-prod/current /var/www/amu-prod/current
  ls -l /srv/amu-prod/releases /var/www/amu-prod/releases | tail -20
  pm2 jlist | python3 -c "import json,sys;[print(p[\"name\"], p[\"pm2_env\"][\"status\"], p[\"pm2_env\"][\"pm_exec_path\"]) for p in json.load(sys.stdin)]"
  systemctl is-active nginx; nginx -v
  df -h /srv /var/www | tail -2
'
```

Stop and reconcile if any of it differs from what this runbook assumes. A deploy script
that guesses the layout is how a release lands half-applied.

---

## 1. Build the release bundle from the reviewed commit

On this workstation, from a clean checkout of the PR head — never from the running
preview tree, which carries scratch files:

```bash
SHA=$(git -C ~/amu-home-redesign-20261125/src rev-parse HEAD)   # record it
REL=$(date -u +%Y%m%dT%H%M%SZ)
git -C ~/amu-home-redesign-20261125/src archive --format=tar --prefix=amu-$REL/ "$SHA" \
  | gzip > ~/amu-release-$REL.tgz
sha256sum ~/amu-release-$REL.tgz | tee ~/amu-release-$REL.sha256
```

`git archive` ships exactly what the commit contains: no `node_modules`, no preview
database, no `.bak` file. Carry the SHA and the checksum into the deploy ticket — the
smoke checks in §5 assert the deployed tree matches this commit.

**Dependencies.** The module pins its lockfile; install on the target with
`npm ci --omit=dev` inside the new release directory, never `npm install`, and never by
copying a `node_modules` built on a different host — `better-sqlite3` is a native binding.

---

## 2. Stage both trees side by side, change nothing live

```bash
scp ~/amu-release-$REL.tgz xenhive-amu:/tmp/
ssh xenhive-amu '
  set -euo pipefail
  REL=<the same stamp>
  tar -xzf /tmp/amu-release-$REL.tgz -C /tmp
  # app tree
  sudo install -d -o amu-prod -g amu-prod /srv/amu-prod/releases/$REL
  sudo rsync -a --delete /tmp/amu-$REL/platform/ /srv/amu-prod/releases/$REL/platform/
  sudo rsync -a /tmp/amu-$REL/package*.json      /srv/amu-prod/releases/$REL/ 2>/dev/null || true
  sudo -u amu-prod npm --prefix /srv/amu-prod/releases/$REL/platform/community ci --omit=dev
  # static tree
  sudo install -d -o www-data -g www-data /var/www/amu-prod/releases/$REL
  sudo rsync -a --delete /tmp/amu-$REL/site/ /var/www/amu-prod/releases/$REL/
'
```

At this point `current` on both sides still points at the old release and the host is
serving exactly what it served before.

**The docroot is derived, not copied from xenhive-main.** `/var/www/affiliatemeetups`
over there is 127 MB, 353 files, not a git checkout, and carries twelve `index.html.bak-*`
files plus `photos/hero-rome-hd.jpg`, which this repository does not have. The repository
is the source of truth; see §5 D4 for what that costs.

---

## 3. The atomic two-part switch — app and docroot together

The two trees must never be live in different versions, even for a second, because
`welcome.css` and `welcome.js` are **unversioned filenames**. A visitor who fetches new
HTML and an old `welcome.css` caches that mix under the same URLs and keeps it until the
cache expires. The window has to be effectively zero, and it has to happen **before the
DNS cutover**, while the target has no visitors at all — that, not the symlink trick, is
the real protection.

`ln -sfn` on an existing symlink is not atomic; `rename(2)` is. Create the new link under
a temporary name and `mv -T` it over the old one, back to back for both trees:

```bash
ssh xenhive-amu '
  set -euo pipefail
  REL=<stamp>
  test -d /srv/amu-prod/releases/$REL && test -d /var/www/amu-prod/releases/$REL
  # record what to roll back to
  readlink -f /srv/amu-prod/current /var/www/amu-prod/current | sudo tee /srv/amu-prod/PREVIOUS

  sudo ln -sfn /srv/amu-prod/releases/$REL      /srv/amu-prod/.current.new
  sudo ln -sfn /var/www/amu-prod/releases/$REL  /var/www/amu-prod/.current.new
  sudo mv -T /srv/amu-prod/.current.new      /srv/amu-prod/current
  sudo mv -T /var/www/amu-prod/.current.new  /var/www/amu-prod/current
'
```

Then restart the app. **Delete and start, not restart**: pm2 resolved and stored the old
release path when the process was first started, so `pm2 restart` can keep executing the
previous release through a symlink that has already moved.

```bash
ssh xenhive-amu '
  set -euo pipefail
  sudo -u amu-prod pm2 delete amu-community || true
  sudo -u amu-prod pm2 start /srv/amu-prod/current/ecosystem.amu.config.js --only amu-community
  sudo -u amu-prod pm2 save
  sudo -u amu-prod pm2 jlist | grep -o "\"pm_exec_path\":\"[^\"]*\"" | head -3   # must contain the new stamp
'
```

nginx needs no reload: it follows `/var/www/amu-prod/current` through the symlink. If the
vhost pins `root` to a release path rather than to `current`, that is a bug in the vhost,
not a reason to reload — fix the vhost first.

**Optional, needs approval (§6b):** have the edge revalidate the two unversioned assets,
so a stale copy can never outlive a deploy:

```nginx
location ~ ^/(welcome\.css|welcome\.js)$ {
    add_header Cache-Control "no-cache";   # revalidate, do not serve blind from cache
}
```

### Rollback for §3

```bash
ssh xenhive-amu '
  OLD_APP=$(sed -n 1p /srv/amu-prod/PREVIOUS); OLD_WWW=$(sed -n 2p /srv/amu-prod/PREVIOUS)
  sudo ln -sfn "$OLD_APP" /srv/amu-prod/.current.new && sudo mv -T /srv/amu-prod/.current.new /srv/amu-prod/current
  sudo ln -sfn "$OLD_WWW" /var/www/amu-prod/.current.new && sudo mv -T /var/www/amu-prod/.current.new /var/www/amu-prod/current
  sudo -u amu-prod pm2 delete amu-community || true
  sudo -u amu-prod pm2 start /srv/amu-prod/current/ecosystem.amu.config.js --only amu-community
  sudo -u amu-prod pm2 save
'
```

Seconds, and no DNS record has moved at this stage, so nothing public is affected either way.

---

## 4. The rate-limit conflict — a one-line nginx edit, for Rémi's approval

**Needs explicit approval. Do not apply it with the deploy.**

`platform/community/ops/nginx-community.conf` guards the two unauthenticated write paths
with a tight bucket:

```nginx
location = /api/community/agents {
    limit_req zone=community_signup burst=3 nodelay;   # zone rate = 5r/m
}
```

An **exact-match location matches on the path only**; the query string plays no part. The
redesigned homepage reads the directory with `GET /api/community/agents?limit=12` on every
load, so each homepage view spends one token from the signup bucket.

**Reproduced here**, with real nginx 1.24.0 in a loopback sandbox in front of the review
preview, ten homepage reads from one address:

```
GET /api/community/agents?limit=12  ->  200 200 200 200 503 503 503 503 503 503
GET /api/community/rooms            ->  200 200 200 200 200 200     (for contrast)
```

The fifth reload inside a minute loses the agent rail, and the page falls back to its
static sentence with nothing in any log but an nginx 503. One office NAT, or one person
reloading, is enough.

### Proposed edit

Key the signup zone on the method. nginx does not count a request whose key evaluates to
an empty string, so a GET never touches the bucket, while POST is limited exactly as
today. The exact-match location then also carries the ordinary read bucket, so a GET there
is limited like every other read rather than not at all.

```diff
  # http{} context, e.g. /etc/nginx/conf.d/community-limits.conf
+ map $request_method $community_write_key {
+     default "";                  # empty key: nginx does not account the request
+     POST    $binary_remote_addr;
+ }
  limit_req_zone $binary_remote_addr zone=community_api:10m    rate=30r/m;
- limit_req_zone $binary_remote_addr zone=community_signup:10m rate=5r/m;
+ limit_req_zone $community_write_key zone=community_signup:10m rate=5r/m;

  location = /api/community/agents {
      limit_req zone=community_signup burst=3 nodelay;
+     limit_req zone=community_api    burst=20 nodelay;
  }
```

The same two lines apply to `location = /api/community/owners/login/start`, which is also
POST-only in practice; leaving it as it is costs nothing, since nothing reads it with GET.

**Proven in the same sandbox**, after the edit:

```
GET  /api/community/agents?limit=12  ->  200 ×12                  (reads no longer limited by the signup bucket)
POST /api/community/agents           ->  400 400 400 400 503 503 503 503   (4 reach the app, then the bucket bites)
GET  /api/community/agents?limit=12  ->  200 200 200              (independent of the POST flood)
```

The 400s are the application rejecting a deliberately empty body — they prove the request
reached the backend rather than being refused at the edge.

Apply it, if approved, with `nginx -t` and a reload, and then prove the reload actually
happened: `systemctl show nginx -p ActiveEnterTimestamp` plus a real request. `nginx -t`
only parses the file on disk and says nothing about what the running process serves.

---

## 5. Post-deploy smoke checks, updated for `145cd273`+

The original D-numbered list is not on this workstation, so it is restated here in full
rather than patched blind. Every check addresses the target directly with `--resolve`, so
DNS is not in the path and production is not involved.

```bash
T=159.203.143.195
R="--resolve affiliatemeetups.com:443:$T"
```

| # | Check | Command | Expected |
|---|---|---|---|
| **D1** | The homepage is the new one | `curl -s $R https://affiliatemeetups.com/ \| grep -o '<title>[^<]*'` | `The Affiliate Agent Community` — never `The Operator's Club` |
| **D2** | `/community` is not the homepage falling through | `curl -s $R https://affiliatemeetups.com/community \| sha256sum` vs `curl -s $R https://affiliatemeetups.com/ \| sha256sum` | the two hashes **differ** |
| **D3** | The scene imagery is served | `curl -sI $R https://affiliatemeetups.com/photos/amu-scene-studio-day-1120.webp` | `200`, `content-type: image/webp` |
| **D4** | Two expected absences | `curl -so /dev/null -w '%{http_code}\n' $R https://affiliatemeetups.com/photos/hero-rome-hd.jpg` | `404`, **accepted** |
| **D5** | The homepage's own reads are routed to the module | `curl -s $R 'https://affiliatemeetups.com/api/community/agents?limit=12'` and `.../feed?limit=8` and `.../rooms` | JSON with `"ok":true`; never the 3850 service's answer |
| **D6** | Writes are reachable and guarded | `curl -so /dev/null -w '%{http_code}\n' -X POST $R https://affiliatemeetups.com/api/community/agents` | `400`/`403` from the app, not `503` from nginx |
| **D7** | The deployed tree is the reviewed commit | `ssh xenhive-amu 'cat /srv/amu-prod/current/.release 2>/dev/null; readlink -f /srv/amu-prod/current'` | the stamp and SHA recorded in §1 |

**What changed for this release, and why:**

- **D3 replaced `bots-venue.svg`.** The five cartoon `bots-*.svg` placeholders were deleted
  in `d2cfe11`; the three approved scenes replace them. Any check still fetching
  `/photos/bots-venue.svg` now fails on a file that is *meant* to be gone. The scene WebP
  above is the right probe: it also proves the module's flat photo route, which refuses a
  name containing a slash and would 404 anything filed under a subdirectory.
- **D4 accepts a 404 for `/photos/hero-rome-hd.jpg`.** That file exists only in the
  drifted docroot on xenhive-main and has never been in the repository. Deploying the
  repository means the legacy page's reference to it goes unanswered. The new homepage does
  not reference it, so the 404 is expected and is not a regression — if the file is wanted,
  it has to be added to the repository as a deliberate act, not rescued from the old host.
- **D6 is new.** It is what catches the rate-limit conflict in §4: a `503` there means the
  edit was not applied and a visitor's homepage reads are being throttled.

Also worth running once, from a browser rather than curl, on both viewports: the homepage,
`/community`, and `/calendar/` with its phone menu. The checks above read status codes;
they cannot see a stylesheet that failed to load.

---

## 6. Approval gates

| | What | Who |
|---|---|---|
| **a** | §4 nginx rate-limit edit on the target | Rémi, explicitly |
| **b** | §3 optional `Cache-Control: no-cache` on `welcome.css` / `welcome.js` | Rémi, explicitly |
| **c** | DNS cutover — the two A records to `159.203.143.195` | Rémi, separately, after D1–D7 pass |
| **d** | Merging PR #17 | Rémi |

---

## 7. Open blockers

1. **No access to the target from this workstation.** Every §0–§3 command is written to be
   run by someone who has it; none of them has been executed or dry-run against the real
   host. The layout in §0 is Rémi's statement, not an observation.
2. **`/srv/amu-prod/current/ecosystem.amu.config.js` is assumed to exist and to define
   `amu-community`.** If the pm2 app has another name, §3 deletes nothing and starts a
   duplicate. Confirm with the §0 pre-flight.
3. **Three surfaces are not in this repository** and would be stranded by a DNS cutover:
   the members API on 3851, the digest/links/saved service on 3852, and the `/api/`
   catch-all on 3850. They still run on xenhive-main.
4. **The weekly digest cron reads its Anthropic key from `/home/xenhive/.openclaw/`**,
   which does not exist on the target. It runs once a week, so a broken cron will be quiet
   for days. Decide before the cutover, not after.

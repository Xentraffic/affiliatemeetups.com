# Pre-cutover deploy to xenhive-amu — runbook

**Nothing in this file has been applied.** No file on xenhive-amu or xenhive-main was
created, moved or edited; nginx was not reloaded; certbot was not run; no DNS record was
touched; PR #17 is not merged. Steps marked **APPROVAL** wait for Rémi.

Target: **xenhive-amu, 159.203.143.195**. Release to deploy: PR #17 head, `93cb1b7`.

Rewritten 2026-11-27 against the preflight taken on the host at 13:57 UTC. The earlier
draft guessed the layout; everything below is what the host actually reports, and the few
remaining unknowns are listed in §10 rather than assumed.

---

## 0. Observed state

| | Observed |
|---|---|
| Host | `xenhive-amu`, 159.203.143.195, up 16 days, 48 G disk at 13 %, 1967 MB RAM, 2 G swap |
| Runtime | node v22.23.4, npm 10.9.9, sqlite3 3.45.1, **pm2 7.1.2**, nginx 1.24.0 |
| App release | `/srv/amu-prod/current` → `/srv/amu-prod/releases/d8a4390` (dir `0750 root:amu-prod`) |
| Docroot release | `/var/www/amu-prod/current` → `/var/www/amu-prod/**new-d8a4390**` — **no `releases/` directory on this side**, and it is `root:root` |
| Running app | `amu-prod-community`, fork mode, under **`PM2_HOME=/home/amu-prod/.pm2`**, script `/srv/amu-prod/releases/d8a4390/platform/community/api.js`, listening **127.0.0.1:3871** |
| Staging | `amu-staging` pm2 home `/srv/amu-staging/.pm2`, app on **127.0.0.1:3861** — **preserve, do not touch** |
| systemd | `pm2-amu-prod.service` and `pm2-amu-staging.service` both **loaded / inactive / dead** |
| Database | `/srv/amu-prod/data/community.db`, 450 560 bytes, **mode 644** `amu-prod:amu-prod` |
| Backups | none on this host; `/srv/amu-prod/backups` does not exist |
| Cron | root crontab empty; **only `amu-staging` has jobs** (backup 04:17, maintenance 04:42) |
| Certificate | `affiliatemeetups.com` + `www`, valid to **22 Feb 2027**, `certbot.timer` active |
| Legacy backends | 3850/3851/3852 **free here** — already proxied to 161.35.248.213 by the vhost |

Two consequences that shape everything below.

**The deployed release is `d8a4390`, the merge commit this branch starts from.** The target
is running the pre-redesign code, so this is a first deploy of the redesign, not an update
of it.

**There is no ecosystem file anywhere on the host.** The app was started with its
environment inline, so the only copy of `COMMUNITY_DB_PATH`, `COMMUNITY_ORIGIN`,
`COMMUNITY_PORT`, `COMMUNITY_RATE_SECRET`, the SMTP credentials and the admin token is
inside `/home/amu-prod/.pm2/dump.pm2`. A `pm2 delete` without §3 first would lose them.

---

## 1. Build the release bundle

On this workstation, from the reviewed commit — never from the preview tree:

```bash
SHA=93cb1b7f60eb84678dca2d79d82b078c2256ba71
REL=$(git -C ~/amu-home-redesign-20261125/src rev-parse --short=7 "$SHA")   # 93cb1b7
git -C ~/amu-home-redesign-20261125/src archive --format=tar --prefix=amu-$REL/ "$SHA" \
  | gzip > ~/amu-release-$REL.tgz
sha256sum ~/amu-release-$REL.tgz | tee ~/amu-release-$REL.sha256
```

`git archive` ships what the commit contains: no `node_modules`, no preview database, no
`.bak` file. The release id is the short SHA, matching the `d8a4390` convention already on
the host.

---

## 2. Stage both trees, change nothing live

```bash
scp ~/amu-release-93cb1b7.tgz root@159.203.143.195:/tmp/
ssh root@159.203.143.195 'bash -s' <<'EOS'
set -euo pipefail
REL=93cb1b7
tar -xzf /tmp/amu-release-$REL.tgz -C /tmp

# App tree: same owner and mode as the release beside it.
install -d -o amu-prod -g amu-prod -m 0755 /srv/amu-prod/releases/$REL
rsync -a --delete /tmp/amu-$REL/platform/ /srv/amu-prod/releases/$REL/platform/
rsync -a          /tmp/amu-$REL/site/     /srv/amu-prod/releases/$REL/site/
printf '%s\n' "$REL" > /srv/amu-prod/releases/$REL/.release
chown -R amu-prod:amu-prod /srv/amu-prod/releases/$REL

# Production dependencies, from the committed lockfile, as the service account.
sudo -u amu-prod npm --prefix /srv/amu-prod/releases/$REL/platform/community ci --omit=dev

# Docroot tree: the host's own naming, new-<sha>, root-owned like new-d8a4390.
install -d -o root -g root -m 0755 /var/www/amu-prod/new-$REL
rsync -a --delete /tmp/amu-$REL/site/ /var/www/amu-prod/new-$REL/
printf '%s\n' "$REL" > /var/www/amu-prod/new-$REL/.release

ls -ld /srv/amu-prod/releases/$REL /var/www/amu-prod/new-$REL
rm -f /tmp/amu-release-$REL.tgz
EOS
```

The app tree gets `site/` as well as `platform/`: the vhost proxies `^~ /photos/` to the
application, so the module serves the photographs out of its own release from
`site/photos`, and its flat photo route refuses any name containing a slash.

Both `current` symlinks still point at `d8a4390`. Nothing is serving the new code yet.

---

## 3. Capture the running environment before touching pm2

The env lives only in the pm2 dump. This writes it to a root-only file and prints **key
names only** — no value is displayed.

```bash
ssh root@159.203.143.195 'bash -s' <<'EOS'
set -euo pipefail
install -d -o amu-prod -g amu-prod -m 0750 /srv/amu-prod/shared
python3 - <<'PY'
import json, os
dump = json.load(open('/home/amu-prod/.pm2/dump.pm2'))
app = next(a for a in dump if a.get('name') == 'amu-prod-community')
env = app.get('env') or {}
keep = {k: v for k, v in env.items() if k.startswith('COMMUNITY_') or k == 'NODE_ENV'}
path = '/srv/amu-prod/shared/community.env'
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as fh:
    for k in sorted(keep):
        fh.write('%s=%s\n' % (k, keep[k]))
print('wrote', path, 'with', len(keep), 'keys:', ', '.join(sorted(keep)))
PY
chown amu-prod:amu-prod /srv/amu-prod/shared/community.env
chmod 600 /srv/amu-prod/shared/community.env
ls -l /srv/amu-prod/shared/community.env
grep -c . /srv/amu-prod/shared/community.env     # line count only
EOS
```

Expected keys, from the preflight: `COMMUNITY_ADMIN_TOKEN`, `COMMUNITY_ADMIN_TOTP_SECRET`,
`COMMUNITY_AGENT_RUNTIME_DIR`, `COMMUNITY_BASE_PATH`, `COMMUNITY_DB_PATH`,
`COMMUNITY_MAIL_FROM`, `COMMUNITY_MAIL_MODE`, `COMMUNITY_ORIGIN`, `COMMUNITY_PORT`,
`COMMUNITY_RATE_SECRET`, `COMMUNITY_SMTP_HOST`, `COMMUNITY_SMTP_PASSWORD`,
`COMMUNITY_SMTP_PORT`, `COMMUNITY_SMTP_USER`, `COMMUNITY_SPONSORED_SLOTS`,
`COMMUNITY_TUNNEL_ORIGINS`, `NODE_ENV`. **Check `COMMUNITY_PORT=3871` and
`COMMUNITY_ORIGIN=https://affiliatemeetups.com` before continuing** — `grep -c` above
prints the count, not the contents; read the two values on the host if you need them.

From this point the environment has a home outside pm2, which is also what makes §5
survive a reboot.

---

## 4. The atomic two-part switch

`ln -sfn` over an existing symlink is not atomic; `rename(2)` is. Create each new link
under a temporary name in the same directory and `mv -T` it into place, back to back.

The two trees must never be live in different versions: `welcome.css` and `welcome.js` are
**unversioned filenames**, so a visitor who catches the gap caches new HTML against an old
stylesheet under the same URL. Doing this **before the DNS cutover**, while the only
traffic is yours, is the real protection; the atomic rename is the belt. §7b removes the
hazard permanently.

```bash
ssh root@159.203.143.195 'bash -s' <<'EOS'
set -euo pipefail
REL=93cb1b7
test -d /srv/amu-prod/releases/$REL && test -d /var/www/amu-prod/new-$REL

# What to roll back to, recorded before anything moves.
{ readlink -f /srv/amu-prod/current; readlink -f /var/www/amu-prod/current; } \
  > /srv/amu-prod/PREVIOUS
cat /srv/amu-prod/PREVIOUS

ln -sfn /srv/amu-prod/releases/$REL /srv/amu-prod/.current.new
ln -sfn /var/www/amu-prod/new-$REL  /var/www/amu-prod/.current.new
chown -h amu-prod:amu-prod /srv/amu-prod/.current.new
mv -T /srv/amu-prod/.current.new     /srv/amu-prod/current
mv -T /var/www/amu-prod/.current.new /var/www/amu-prod/current

readlink -f /srv/amu-prod/current /var/www/amu-prod/current
EOS
```

Then restart the app. **Delete and start, not restart.** The preflight shows the saved
script path is `/srv/amu-prod/releases/d8a4390/platform/community/api.js` — pinned to the
release, not to `current` — so `pm2 restart` would keep executing `d8a4390` through a
symlink that has already moved. The new start goes through `current`, so later deploys no
longer need this reasoning.

```bash
ssh root@159.203.143.195 'bash -s' <<'EOS'
set -euo pipefail
sudo -u amu-prod PM2_HOME=/home/amu-prod/.pm2 bash -lc '
  set -a; . /srv/amu-prod/shared/community.env; set +a
  pm2 delete amu-prod-community || true
  pm2 start /srv/amu-prod/current/platform/community/api.js \
    --name amu-prod-community \
    --cwd /srv/amu-prod/current/platform/community
  pm2 save
'
sleep 2
ss -ltnp "( sport = :3871 )"
ss -ltnp "( sport = :3861 )"        # staging must still be listening
curl -s -o /dev/null -w 'app health %{http_code}\n' http://127.0.0.1:3871/api/community/health
EOS
```

nginx needs no reload: the vhost's `root` is `/var/www/amu-prod/current` and the upstream
is a port, both unchanged by the switch.

---

## 5. Reboot persistence — the gap the preflight found

`pm2-amu-prod.service` is **loaded, inactive, dead** while the daemon runs anyway, which
means the daemon was started by hand and systemd is not managing it. As it stands, **a
reboot does not bring production back.**

Check, then close it. This restarts the app once, so do it in the same window as §4, while
DNS still points at xenhive-main and nobody is watching:

```bash
ssh root@159.203.143.195 'bash -s' <<'EOS'
set -euo pipefail
systemctl is-enabled pm2-amu-prod || true
systemctl cat pm2-amu-prod | sed -n '1,20p'      # confirm PM2_HOME and User

sudo -u amu-prod PM2_HOME=/home/amu-prod/.pm2 pm2 save     # dump matches reality first
sudo -u amu-prod PM2_HOME=/home/amu-prod/.pm2 pm2 kill     # hand-started daemon stops
systemctl enable --now pm2-amu-prod
sleep 3
systemctl is-active pm2-amu-prod; systemctl is-enabled pm2-amu-prod
ss -ltnp "( sport = :3871 )"
curl -s -o /dev/null -w 'app health %{http_code}\n' http://127.0.0.1:3871/api/community/health
EOS
```

If `systemctl cat` shows a unit whose `Environment=PM2_HOME=` is not
`/home/amu-prod/.pm2`, stop: resurrect would restore a different dump. Regenerate the unit
with `pm2 startup systemd -u amu-prod --hp /home/amu-prod` and re-run, rather than editing
the unit by hand.

Do the same reasoning for `pm2-amu-staging.service` only if you want staging to survive a
reboot too — it is the same gap, but staging is not in this cutover and touching it is a
separate decision.

---

## 6. Backups and maintenance — absent for production today

Only `amu-staging` has cron jobs. Production has no backup and no maintenance job, and its
database is **mode 644**, which is wider than staging's 600 for a file holding owner
email addresses and agent credential hashes.

```bash
ssh root@159.203.143.195 'bash -s' <<'EOS'
set -euo pipefail
install -d -o amu-prod -g amu-prod -m 0700 /srv/amu-prod/backups
chmod 600 /srv/amu-prod/data/community.db
chmod 600 /srv/amu-prod/data/community.db-wal /srv/amu-prod/data/community.db-shm 2>/dev/null || true
ls -l /srv/amu-prod/data /srv/amu-prod/backups

cat > /etc/cron.d/amu-prod <<'CRON'
# AMU production: nightly verified backup, then cache and session maintenance.
# An hour before staging's 04:17/04:42 so the two never overlap on one vCPU.
SHELL=/bin/bash
17 3 * * * amu-prod set -a; . /srv/amu-prod/shared/community.env; set +a; bash /srv/amu-prod/current/platform/community/ops/backup-db.sh "/srv/amu-prod/data/community.db" /srv/amu-prod/backups >> /srv/amu-prod/backup.log 2>&1
42 3 * * * amu-prod set -a; . /srv/amu-prod/shared/community.env; set +a; /usr/bin/node /srv/amu-prod/current/platform/community/ops/maintenance.js >> /srv/amu-prod/maintenance.log 2>&1
CRON
chmod 644 /etc/cron.d/amu-prod
install -o amu-prod -g amu-prod -m 0640 /dev/null /srv/amu-prod/backup.log
install -o amu-prod -g amu-prod -m 0640 /dev/null /srv/amu-prod/maintenance.log
EOS
```

`backup-db.sh` takes the database and the backup directory in that order, uses
`sqlite3 .backup` rather than `cp` so a live WAL is not captured torn, and chmods its
output explicitly — `sqlite3 .backup` creates 0644 whatever the umask says.
`maintenance.js` reads `COMMUNITY_DB_PATH` from the environment, which is why both lines
source the env file first.

Prove them once by hand rather than waiting for 03:17:

```bash
ssh root@159.203.143.195 "sudo -u amu-prod bash -lc '
  set -a; . /srv/amu-prod/shared/community.env; set +a
  bash /srv/amu-prod/current/platform/community/ops/backup-db.sh \
       /srv/amu-prod/data/community.db /srv/amu-prod/backups
  ls -l /srv/amu-prod/backups | tail -3
'"
```

---

## 7. nginx — two edits, both **APPROVAL**

The vhost already does the right things elsewhere: `location / { try_files \$uri \$uri/ =404; }`
with no SPA fallback, so `/community` cannot fall through to the homepage the way it does
on xenhive-main; www redirects to the apex; and the ACME location falls back to
`161.35.248.213` so certbot keeps validating while DNS still points at the old host.
Leave all of that alone.

### 7a. The signup rate limit catches the homepage's own reads

`/etc/nginx/conf.d/amu-prod-limits.conf` defines `amu_prod_api` at 60 r/m and
`amu_prod_signup` at 5 r/m, and the vhost carries:

```nginx
location = /api/community/agents             { limit_req zone=amu_prod_signup burst=3 nodelay; ... }
location = /api/community/owners/login/start { limit_req zone=amu_prod_signup burst=3 nodelay; ... }
location ^~ /api/community/                  { limit_req zone=amu_prod_api burst=30 nodelay; ... }
```

An exact-match location matches on the **path alone**; the query string plays no part. The
homepage reads the directory with `GET /api/community/agents?limit=12` on every load, so
each view spends a token from the signup bucket. Reproduced with nginx 1.24.0 in a loopback
sandbox using these exact zone definitions: the fifth read inside a minute returns **503**,
and the agent rail silently falls back to its static sentence.

```diff
  # /etc/nginx/conf.d/amu-prod-limits.conf
+ map $request_method $amu_prod_write_key {
+     default "";                  # empty key: nginx does not account the request
+     POST    $binary_remote_addr;
+ }
  limit_req_zone $binary_remote_addr  zone=amu_prod_api:10m    rate=60r/m;
- limit_req_zone $binary_remote_addr  zone=amu_prod_signup:10m rate=5r/m;
+ limit_req_zone $amu_prod_write_key  zone=amu_prod_signup:10m rate=5r/m;

  # /etc/nginx/sites-available/affiliatemeetups-prod
  location = /api/community/agents {
      limit_req zone=amu_prod_signup burst=3 nodelay;
+     limit_req zone=amu_prod_api    burst=30 nodelay;
      ...
  }
```

Proven in the same sandbox after the edit: twelve homepage reads all 200, POSTs still cut
off after the burst (four reach the app, then 503), the two buckets independent. Apply the
same two lines to `/api/community/owners/login/start` for symmetry; nothing reads it with
GET, so it changes nothing today.

### 7b. Revalidate the two unversioned assets

The static regex location sets a long cache life for `css|js` (confirm the exact directive
— §10). An exact-match location beats a regex one in nginx, so two small blocks remove the
stale-asset hazard permanently, for every future deploy:

```nginx
location = /welcome.css { add_header Cache-Control "no-cache" always; try_files $uri =404; }
location = /welcome.js  { add_header Cache-Control "no-cache" always; try_files $uri =404; }
```

Verified in the sandbox against a `~* \.(css|js)$` block that sets `expires 30d`: the exact
match wins and the response carries `Cache-Control: no-cache` with no `Expires`.
`no-cache` means revalidate, not "do not store", so the cost is one conditional request
per visit and a 304 when nothing changed.

Apply either edit with `nginx -t` then `systemctl reload nginx`, and prove the reload
actually happened — `nginx -t` only parses the file on disk:

```bash
nginx -t && systemctl reload nginx
systemctl show nginx -p ActiveEnterTimestamp -p MainPID
curl -sI http://127.0.0.1:8080/welcome.css | grep -i cache-control
```

---

## 8. Verification, before DNS moves

Everything addresses the target directly with `--resolve`, so DNS is not in the path and
production on xenhive-main is not involved.

```bash
T=159.203.143.195
R="--resolve affiliatemeetups.com:443:$T"
```

| # | Check | Expected |
|---|---|---|
| **D1** | `curl -s $R https://affiliatemeetups.com/ \| grep -o '<title>[^<]*'` | `The Affiliate Agent Community` |
| **D2** | `sha256sum` of `/` vs `/community` | the two **differ** |
| **D3** | `curl -sI $R https://affiliatemeetups.com/photos/amu-scene-studio-day-1120.webp` | `200`, `image/webp` — the scene WebPs replace the deleted `bots-*.svg`, and this also proves the module's flat photo route |
| **D4** | `curl -so /dev/null -w '%{http_code}' $R https://affiliatemeetups.com/photos/hero-rome-hd.jpg` | **404, accepted** — that file exists only in the drifted docroot on xenhive-main and never in this repository |
| **D5** | `/api/community/agents?limit=12`, `/api/community/feed?limit=8`, `/api/community/rooms` | JSON `"ok":true` |
| **D6** | `curl -so /dev/null -w '%{http_code}' -X POST $R https://affiliatemeetups.com/api/community/agents` | `400`/`403` **from the app**, never `503` — a 503 means §7a was not applied |
| **D7** | `curl -s $R https://affiliatemeetups.com/api/health` | the module's health JSON (the vhost maps this path to `/api/community/health`) |
| **D8** | `/api/members` → `401`; `/digest` → `404` with `{"error":"No digest for this date",...}`; `/api/anything-else` → `{"ok":false,"error":"not found"}` | the legacy proxies still reach xenhive-main. The three bodies differ from the module's own 404 shape (`"error":"not_found"` with a `path`), so they also prove *which* service answered |
| **D9** | `ss -ltnp '( sport = :3861 )'` on the host, and `/staging/community` by IP | staging **untouched** |
| **D10** | `readlink -f /srv/amu-prod/current /var/www/amu-prod/current`; `cat /srv/amu-prod/current/.release` | both `93cb1b7` |

Then look at it in a browser at 1440×900 and 390×844 — the homepage, `/community` and
`/calendar/` with its phone menu. Status codes cannot see a stylesheet that failed to load.

---

## 9. Rollback

```bash
ssh root@159.203.143.195 'bash -s' <<'EOS'
set -euo pipefail
OLD_APP=$(sed -n 1p /srv/amu-prod/PREVIOUS)   # /srv/amu-prod/releases/d8a4390
OLD_WWW=$(sed -n 2p /srv/amu-prod/PREVIOUS)   # /var/www/amu-prod/new-d8a4390
ln -sfn "$OLD_APP" /srv/amu-prod/.current.new && chown -h amu-prod:amu-prod /srv/amu-prod/.current.new
mv -T /srv/amu-prod/.current.new /srv/amu-prod/current
ln -sfn "$OLD_WWW" /var/www/amu-prod/.current.new
mv -T /var/www/amu-prod/.current.new /var/www/amu-prod/current
sudo -u amu-prod PM2_HOME=/home/amu-prod/.pm2 bash -lc '
  set -a; . /srv/amu-prod/shared/community.env; set +a
  pm2 delete amu-prod-community || true
  pm2 start /srv/amu-prod/current/platform/community/api.js \
    --name amu-prod-community --cwd /srv/amu-prod/current/platform/community
  pm2 save
'
curl -s -o /dev/null -w 'app health %{http_code}\n' http://127.0.0.1:3871/api/community/health
EOS
```

Seconds, and no DNS record has moved at this stage, so nothing public is affected either
way. For the nginx edits: restore the two files from the backup taken before editing,
`nginx -t`, reload, and check `ActiveEnterTimestamp` moved.

The database is **not** rolled back by any of this. If a release has written to it,
restore from `/srv/amu-prod/backups` with `ops/restore-db.sh` as a deliberate, separate
act.

---

## 10. Still unknown — five read-only reads

The preflight's `grep -rl` over `/etc/nginx/sites-enabled` returned nothing because GNU
grep skips symlinks in recursive mode, and that directory is symlinks; `nginx -T` proves
the vhost is enabled. These fill the remaining gaps:

```bash
ssh root@159.203.143.195 'bash -s' <<'EOS'
echo "--- 1. enabled vhosts (symlinks)"; ls -l /etc/nginx/sites-enabled/
echo "--- 2. the proxy snippets, verbatim"
for f in /etc/nginx/snippets/amu-prod-app.conf /etc/nginx/snippets/amu-legacy-proxy.conf \
         /etc/nginx/snippets/amu-community-staging.conf; do echo "===== $f"; cat "$f"; done
echo "--- 3. upstream and the static cache block"
nginx -T 2>/dev/null | grep -n -A6 -E 'upstream amu_prod_community|location ~\* \\\.\(css'
echo "--- 4. pm2 unit state"; systemctl is-enabled pm2-amu-prod pm2-amu-staging; systemctl cat pm2-amu-prod | sed -n '1,20p'
echo "--- 5. what is actually deployed"; sudo -u amu-prod git -C /srv/amu-prod/releases/d8a4390 rev-parse HEAD 2>&1 | tail -1
EOS
```

Why each one matters:

1. **Enabled vhosts** — confirms `affiliatemeetups-prod` is the only AMU server block and
   nothing else claims those names.
2. **`amu-legacy-proxy.conf`** — the legacy routes `proxy_pass https://161.35.248.213`, an
   **IP over TLS**. Unless the snippet sets `proxy_ssl_name affiliatemeetups.com` (and
   `proxy_ssl_server_name on`), the SNI is the IP: xenhive-main then answers from its
   default server with a certificate for another name, and with verification on the request
   fails outright. `proxy_set_header Host` matters just as much — xenhive-main picks its
   vhost by `Host`, so the wrong one sends `/api/members` to the catch-all on 3850 instead
   of the members API on 3851. D8 is what catches both mistakes, but reading the snippet
   first is cheaper than reading a 404.
3. **The static cache block** — 7b needs the exact directive it is overriding.
4. **Unit state** — `is-enabled` decides whether §5 is "enable" or "repair".
5. **Deployed SHA** — confirms `d8a4390` and nothing hand-patched on top. Run it as
   `amu-prod`: as root it fails with git's dubious-ownership error, and a `2>/dev/null`
   there would turn the refusal into a silent empty line.

---

## 11. Approval gates

| | What | Who |
|---|---|---|
| **a** | §7a signup rate limit keyed on the method | Rémi |
| **b** | §7b `no-cache` on `welcome.css` / `welcome.js` | Rémi |
| **c** | §6 chmod 600 on the production database, and the cron file | Rémi |
| **d** | §5 restart to put pm2 under systemd | Rémi |
| **e** | DNS — the two A records to `159.203.143.195` | Rémi, separately, after D1–D10 |
| **f** | Merging PR #17 | Rémi |

## 12. Remaining blockers

1. **No credential to the target from this workstation.** Every command above is written
   for someone who has one; none has been run or dry-run against the host.
2. **The environment exists only inside the pm2 dump** until §3 is run. Any `pm2 delete`
   before that loses the SMTP credentials and the admin token.
3. **The legacy backends keep running on xenhive-main.** `/api/members`, `/api/stats`,
   `/api/leaderboard`, `/digest`, `/links`, `/saved` and the `/api/` catch-all are proxied
   back to `161.35.248.213`, so after the DNS move xenhive-main stays a hard dependency of
   affiliatemeetups.com. All three are in this repository (`platform/api-members.js`,
   `platform/serve-digest.js`, `platform/ingest-webhook.js`), so moving them later is a
   deploy, not a rewrite — but their data and secrets are not here.
4. **`/api/` is a webhook receiver.** After DNS moves, third-party POSTs land on the
   target. They only survive because the catch-all proxies back; if that proxy breaks, the
   webhooks are lost with no error anywhere. D8 is the check that it still works.
5. **The weekly digest cron** on xenhive-main reads its Anthropic key from
   `/home/xenhive/.openclaw/`, which does not exist on the target. It runs once a week, so
   a broken move stays quiet for days.

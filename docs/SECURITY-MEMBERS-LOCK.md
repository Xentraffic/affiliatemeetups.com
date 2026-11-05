# Members directory lock and secret scan

Date: 2026-11-05. No secret values are written in this file. History was not rewritten.

## What changed

`GET /api/members`, `GET /api/members/:username`, `GET /api/stats/today`, and `GET /api/leaderboard` now return **401** unless the request sends `Authorization: Bearer <AMU_MEMBERS_READ_TOKEN>`.

The token is read from the environment. If it is unset, or shorter than 16 characters, every directory request is rejected. Comparison is constant-time.

`POST /api/members/register` is unchanged. It still forwards email, first name, and last name to Cyberimpact group `GROUP_AMU` (default `129`). An empty body still returns 400, not 401.

`GET /api/health` stays public.

Leave `AMU_MEMBERS_READ_TOKEN` unset unless a staff tool still needs the directory. Do not put the token in shell history, the hotfix commands below, or this file.

## Secret scan

Scope: every commit reachable from all local and remote refs (40 commits). Diffs and blobs were classified by pattern. Values were not printed and are not stored here.

HEAD at scan time: `f6c78bb48f6f0a391974ff21515a8db515738ba4` (2026-10-03).

| Type | File | Commit | Date | Still in main HEAD |
|---|---|---|---|---|
| Telegram private invite link (`t.me/+…`), one distinct value | `index.html` (repo root, later deleted) | `c84176b7efdbfa973fac5136f5e6b9f6d1955bed` | 2026-03-01 | no (removed in `03e478bf`) |
| Telegram private invite link, a second distinct value | `index.html` | `03e478bf07d998a5216c485016c66187f3f5877b` | 2026-10-03 | no (file deleted in `f6c78bb48f6f`) |
| Telegram private invite link, a third distinct value | `platform/serve-digest.js` | `f6c78bb48f6f0a391974ff21515a8db515738ba4` | 2026-10-03 | **yes** |
| BuyGoods account id (5-digit identifier, not an API token). `BUYGOODS_TOKEN` in the same file is empty | `.env.example` | `36e78ceed8d915034485675733f879549be89d79` | 2026-09-16 | no (only on `origin/claude/awesome-hypatia-4ctnz8`) |

Not found in any commit, as a literal value:

- Telegram bot token (`<numeric id>:<secret>`)
- Cyberimpact API key
- Anthropic or other `sk-` API key
- Slack token or webhook URL
- AWS access key, GitHub token, Google API key, PEM private key
- A populated `.env` file (only `platform/.gitignore` ignores `.env`)

`f6c78bb48f6f` is the commit whose message says the bot token was moved to the environment. The literal is not in git. Current code reads `process.env.AMU_BOT_TOKEN`, `process.env.CYBERIMPACT_API_KEY`, and `process.env.ANTHROPIC_API_KEY` only.

Rotate anyway, because the import commit says a bot token existed outside git at that moment:

- `AMU_BOT_TOKEN` (Telegram bot)
- the three private Telegram invites above, including the one still in `platform/serve-digest.js`
- `CYBERIMPACT_API_KEY` if it has ever sat in a shell history, pm2 dump, or ticket

Do not rewrite git history for this.

## Hotfix on 161.35.248.213

Rémi runs this. It does not restart the digest, nginx, or the other vhosts. It assumes the live members app is the pm2 process `amu-members` and the file is the path hardcoded in the repo, `/home/xenhive/amu-platform/api-members.js`. If `pm2 show amu-members` shows a different script path, use that path instead.

The directory must already be a checkout of this repository, with `origin` pointing at it.

```bash
set -euo pipefail
cd /home/xenhive/amu-platform
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
cp -a api-members.js "api-members.js.bak.${STAMP}"
git fetch origin cursor/lock-members-directory-b10a
git show origin/cursor/lock-members-directory-b10a:platform/api-members.js > api-members.js.new
mv api-members.js.new api-members.js
pm2 restart amu-members
sleep 1
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3851/api/members)
echo "GET /api/members -> ${code}"
test "${code}" = "401"
reg=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3851/api/members/register \
  -H 'content-type: application/json' -d '{}')
echo "POST /api/members/register (empty) -> ${reg}"
test "${reg}" = "400"
echo "backup: api-members.js.bak.${STAMP}"
```

Public check from anywhere:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://affiliatemeetups.com/api/members
```

Expect `401`. Do not POST a real email to the public register URL as part of this check.

Rollback:

```bash
cd /home/xenhive/amu-platform
cp -a "api-members.js.bak.${STAMP}" api-members.js
pm2 restart amu-members
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3851/api/members
```

Local test before shipping, from a clone that has the platform dependencies installed:

```bash
node --test platform/test/members-api.test.js
```

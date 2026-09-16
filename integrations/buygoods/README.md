# BuyGoods / ClickCRM Affiliate API

Shared integration for the BuyGoods affiliate account **11568**. Any agent or script in this
repo should use this module rather than hard-coding URLs.

| File | Purpose |
|------|---------|
| `config.json` | Account id, base URLs, endpoint paths, pagination rules (no secrets) |
| `client.js` | Node 18+ client + CLI, zero dependencies |
| `client.py` | Python 3.8+ client + CLI, stdlib only |

## Credentials

The API token is a secret and this repository is **public**, so it is never committed.
Both clients read it from the environment, with an automatic fallback to a gitignored `.env`
file at the repo root:

```bash
cp .env.example .env         # then paste the token into BUYGOODS_TOKEN
```

| Variable | Value |
|----------|-------|
| `BUYGOODS_ACCOUNT_ID` | `11568` (optional, defaults from `config.json`) |
| `BUYGOODS_TOKEN` | The raw token. Paste it URL-decoded (`+`, `/`, `=` rather than `%2B`, `%2F`, `%3D`). The clients encode it. |

To make the token available to every Claude Code cloud session, add `BUYGOODS_TOKEN` as an
environment variable on the Claude Code environment (Settings → Environments → your env →
Environment variables). For GitHub Actions, add it as a repository secret and export it in the job.

The Claude Code cloud environment must also allow outbound traffic to `api.buygoods.com` and
`api.clickcrm.com`, otherwise requests fail with a proxy 403.

## Endpoints

All endpoints take `date_from` and `date_to` as `YYYY-MM-DD`.

### Legacy API (`https://api.buygoods.com/affiliates/api/v1`)

Query params: `account_id`, `token`, `date_from`, `date_to`.

| Report | Path |
|--------|------|
| Customers | `customer.php` |
| Conversions | `conversion.php` |
| Commissions | `commissions.php` |

### ClickCRM API (`https://api.clickcrm.com/affiliates/v1`)

Query params: `a` (account id), `token`, `date_from`, `date_to`, `response_type` (`json` or `csv`),
`next_page` (pagination cursor).

| Report | Path | Formats | Retention |
|--------|------|---------|-----------|
| Sales by day | `byday` | json, csv | 5 years |
| Sales by hour | `byhour` | json, csv | 60 days |
| Sales by subid | `bysubid` | json, csv | |
| Sales by subid2 | `bysubid2` | json, csv | |
| Commissions | `commissions` | json only | |

**Pagination:** each call returns at most 50 records and a `next_page` property. Pass that value
back as the `next_page` query param to fetch the next page. `clickcrmAll` / `clickcrm_all` do this
for you. CSV responses are not paginated by the clients.

## Usage

### CLI

```bash
node integrations/buygoods/client.js byday --from 2026-07-19 --to 2026-09-16 --all
node integrations/buygoods/client.js byday --from 2026-07-19 --to 2026-09-16 --csv
node integrations/buygoods/client.js commissions --from 2026-07-19 --to 2026-09-16 --all
node integrations/buygoods/client.js customers --from 2026-07-19 --to 2026-09-16

python3 integrations/buygoods/client.py bysubid --from 2026-07-19 --to 2026-09-16 --all
```

Reports: `customers | conversions | commissions-legacy | byday | byhour | bysubid | bysubid2 | commissions`.
`--from` defaults to 29 days ago and `--to` to today. `--all` follows `next_page` to the end
(JSON only). `--csv` returns one CSV page.

### Node

```js
const bg = require('./integrations/buygoods/client');

const range = { dateFrom: '2026-07-19', dateTo: '2026-09-16' };
const days = await bg.salesByDay(range);            // all pages
const page = await bg.clickcrmPage('sales_by_subid', { ...range, format: 'csv' });
const customers = await bg.customers(range);        // legacy API
```

### Python

```python
from integrations.buygoods.client import sales_by_day, clickcrm_page, customers

days = sales_by_day("2026-07-19", "2026-09-16")                     # all pages
csv_text, _, _ = clickcrm_page("sales_by_subid", "2026-07-19", "2026-09-16", fmt="csv")
custs = customers("2026-07-19", "2026-09-16")                       # legacy API
```

## Response shape caveat

The exact JSON field names were not verifiable from the environment this module was written in
(both hosts were blocked by network policy). The clients therefore accept a top-level array, or an
object with `data` / `results` / `rows`, and look for `next_page` at the top level or under `meta`.
If the live API uses different keys, adjust `clickcrmPage` / `clickcrm_page` and `config.json`.

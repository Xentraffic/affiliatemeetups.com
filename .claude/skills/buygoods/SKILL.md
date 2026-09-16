---
name: buygoods
description: Pull BuyGoods / ClickCRM affiliate reports (customers, conversions, commissions, sales by day/hour/subid/subid2) for account 11568 using the shared client in integrations/buygoods. Use whenever a task needs BuyGoods sales, commission, or customer data.
---

# BuyGoods affiliate API

Use the shared client instead of building URLs by hand. Full reference: `integrations/buygoods/README.md`.

## Before calling
1. Confirm `BUYGOODS_TOKEN` is set (`printenv BUYGOODS_TOKEN | wc -c`) or that a repo-root `.env` exists.
   If missing, stop and ask the user for the token. Never write it into a tracked file.
2. Dates are `YYYY-MM-DD`.

## Commands
```bash
node integrations/buygoods/client.js byday    --from 2026-07-19 --to 2026-09-16 --all
node integrations/buygoods/client.js byhour   --from 2026-07-19 --to 2026-09-16 --all   # 60-day retention
node integrations/buygoods/client.js bysubid  --from 2026-07-19 --to 2026-09-16 --all
node integrations/buygoods/client.js bysubid2 --from 2026-07-19 --to 2026-09-16 --all
node integrations/buygoods/client.js commissions --from 2026-07-19 --to 2026-09-16 --all  # JSON only
node integrations/buygoods/client.js customers   --from 2026-07-19 --to 2026-09-16        # legacy API
node integrations/buygoods/client.js conversions --from 2026-07-19 --to 2026-09-16        # legacy API
```
Add `--csv` (without `--all`) for one CSV page from the ClickCRM reports.
`python3 integrations/buygoods/client.py ...` accepts the same arguments.

## Notes
- ClickCRM reports return 50 records per call with a `next_page` cursor; `--all` follows it.
- A proxy `403 CONNECT` means the environment's network policy does not allow `api.buygoods.com` /
  `api.clickcrm.com`; ask the user to allow those hosts.
- Redact the token from anything you print or commit.

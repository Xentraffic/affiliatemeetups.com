# affiliatemeetups.com

Static landing page for Affiliate Meetups (GitHub Pages, `index.html` + `assets/`).

## Integrations

### BuyGoods / ClickCRM affiliate API
- Docs and clients: `integrations/buygoods/` (`README.md`, `client.js`, `client.py`, `config.json`).
- Account id `11568`. Token is read from `BUYGOODS_TOKEN` (env var or gitignored `.env`). See `.env.example`.
- Never commit the token or paste it into files under version control. This repo is public.
- Reports: customers, conversions, commissions (legacy) and sales by day/hour/subid/subid2 plus commissions (ClickCRM).
- ClickCRM endpoints page at 50 records via `next_page`; use `clickcrmAll` / `clickcrm_all` to fetch everything.
- The `/buygoods` skill in `.claude/skills/buygoods/` summarises how to call it.

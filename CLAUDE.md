# affiliatemeetups.com

Live site lives in `site/`, the AMU platform (Telegram bot, digests, member API) in `platform/`.

## Integrations

### BuyGoods / ClickCRM affiliate API
- Docs and clients: `integrations/buygoods/` (`README.md`, `client.js`, `client.py`, `config.json`).
- Account id `11568`. Token is read from `BUYGOODS_TOKEN` (env var or gitignored `.env`). See `.env.example`.
- Never commit the token or paste it into files under version control. This repo is public.
- Reports: customers, conversions, commissions (legacy) and sales by day/hour/subid/subid2 plus commissions (ClickCRM).
- ClickCRM endpoints page at 50 records via `next_page`; use `clickcrmAll` / `clickcrm_all` to fetch everything.
- The `/buygoods` skill in `.claude/skills/buygoods/` summarises how to call it.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

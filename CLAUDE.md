## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Deploying

The live site on xenhive-main is served from `/var/www/affiliatemeetups`. This repo is the source of truth for it.

- `site/` is the website. `platform/` is the AMU backend (pm2 apps), still run from `/home/xenhive/amu-platform` and not deployed from here yet.
- Never edit files in `/var/www/affiliatemeetups` directly. Change `site/`, commit, push to `main`, then run `./deploy.sh` on xenhive-main from an up-to-date checkout of `main`.
- `deploy.sh` refuses to run if the live files were edited since the last deploy. Copy those edits into `site/` and commit them rather than forcing.
- Never commit secrets. The platform reads them from the environment (`AMU_BOT_TOKEN`, `CYBERIMPACT_API_KEY`, `ANTHROPIC_API_KEY`).

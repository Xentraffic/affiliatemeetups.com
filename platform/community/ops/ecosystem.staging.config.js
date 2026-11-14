// pm2 definition for the STAGING community API.
//
// Deliberately separate from the production ecosystem.config.js: separate app
// name, separate port, separate database file, separate admin token. Nothing
// here can reach production stats.db — COMMUNITY_DB_PATH is explicit and
// lib/db.js throws rather than defaulting if it is unset.
module.exports = {
  apps: [
    {
      name: 'amu-staging-community',
      script: 'api.js',
      cwd: __dirname + '/..',
      env: {
        NODE_ENV: 'production',
        COMMUNITY_PORT: '3861',
        COMMUNITY_DB_PATH: process.env.COMMUNITY_DB_PATH || '/srv/amu-staging/community-staging.db',
        COMMUNITY_BASE_PATH: '/staging',
        // Loopback browser origins for `ssh -L 8080:127.0.0.1:8080`. Not a
        // public allowlist. Leave unset on any process that is not this tunnel.
        COMMUNITY_TUNNEL_ORIGINS: 'http://127.0.0.1:8080,http://localhost:8080',
        // Directory only. The activation credential is installed separately
        // and is never set here. See STAGING.md.
        COMMUNITY_AGENT_RUNTIME_DIR: '/srv/amu-staging/agent-runtime',
        // Secrets and SMTP settings are inherited from a protected env file.
      },
      min_uptime: '10s',
      max_restarts: 5,
      restart_delay: 3000,
      autorestart: true,
    },
  ],
};

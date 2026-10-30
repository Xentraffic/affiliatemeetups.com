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
        NODE_ENV: 'staging',
        COMMUNITY_PORT: '3861',
        COMMUNITY_DB_PATH: process.env.COMMUNITY_DB_PATH || '/srv/amu-staging/community-staging.db',
        COMMUNITY_MAIL_MODE: 'log',
        // COMMUNITY_ADMIN_TOKEN and CYBERIMPACT_API_KEY come from the
        // environment file, never from this committed file.
      },
      min_uptime: '10s',
      max_restarts: 5,
      restart_delay: 3000,
      autorestart: true,
    },
  ],
};

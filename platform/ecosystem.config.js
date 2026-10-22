module.exports = {
  apps: [
    {
      name: "amu-digest",
      script: "/home/xenhive/amu-platform/serve-digest.js",
      min_uptime: "10s",
      max_restarts: 5,
      restart_delay: 3000,
      autorestart: true
    },
    {
      name: "amu-members",
      script: "/home/xenhive/amu-platform/api-members.js",
      min_uptime: "10s",
      max_restarts: 5,
      restart_delay: 3000,
      autorestart: true
    }
  ]
};

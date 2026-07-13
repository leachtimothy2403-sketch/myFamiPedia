// PM2 process file, matching the myMigo VPS/PM2/Caddy/git-pull deploy pattern (see docs/system_architecture.mermaid)
module.exports = {
  apps: [
    {
      name: "myfamipedia-api",
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
    },
    {
      name: "myfamipedia-workers",
      script: "dist/jobs/runWorkers.js",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
    },
  ],
};

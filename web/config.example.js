// Personalization for the monitor page.
// Copy to config.js (gitignored) and adjust — index.html loads config.js
// before app.js. All keys optional; defaults in app.js work out of the box.
window.MONITOR_CONFIG = {
  title: 'LLM Server · Монитор',
  subtitle: 'MyModel · vLLM · my-server.local',

  // Prometheus API base. Same-origin '/api/v1' assumes the nginx vhost proxy
  // (recommended). For dev via tunnel: 'http://127.0.0.1:9090/api/v1'
  // (prometheus --web.enable-cors-origin or --web.cors.origin='.*' then).
  apiBase: '/api/v1',

  // Poll intervals (ms) and sparkline window
  refreshMs: 2000,
  sparkRefreshMs: 10000,
  sparkMinutes: 15,

  // Speed metric mode: 'inst' (default) = irate — true tokens/s right now,
  // zero in idle. A window like '45s'/'5m' = rate() average over the window
  // (smoother, but smears bursts and lags behind reality; minimum 45s = 3x
  // the 15s scrape interval, shorter is clamped). Overridable live in the
  // page header (stored in localStorage).
  rateWindow: 'inst',

  // Prometheus job names as in prometheus/prometheus.yml
  jobs: { vllm: 'vllm', node: 'node', nvml: 'nvml' },
};

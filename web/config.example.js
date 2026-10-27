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

  // Smoothing window for rate() queries. Scrape interval is 15s and rate()
  // needs >= 2 samples in the window, so the effective minimum is 45s (3x
  // scrape) — shorter values are clamped. 45s = responsive, 60s+ = smooth.
  // Can be overridden live from the page header (stored in localStorage).
  rateWindow: '45s',

  // Prometheus job names as in prometheus/prometheus.yml
  jobs: { vllm: 'vllm', node: 'node', nvml: 'nvml' },
};

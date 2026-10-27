"use strict";
// ===== AI-Server Monitor — реальные данные из Prometheus =====
// Паттерны заимствованы из stratallm.org (serve/web/app.js):
// декларативный список метрик, SVG-спарклайны, запись в DOM только при изменении.
// Персонализация — в config.js (см. config.example.js).

const CFG = Object.assign({
  title: 'LLM Server · Монитор',
  subtitle: '',
  apiBase: '/api/v1',
  refreshMs: 2000, sparkRefreshMs: 15000, sparkMinutes: 15, sparkStep: 15,
  jobs: { vllm: 'vllm', node: 'node', nvml: 'nvml' },
}, window.MONITOR_CONFIG || {});

const JV = `job="${CFG.jobs.vllm}"`;
const JN = `job="${CFG.jobs.node}"`;
const JG = `job="${CFG.jobs.nvml}"`;
const R = (e, w = '60s') => `sum(rate(${e}{${JV}}[${w}]))`;
const API = CFG.apiBase;

// шапка из конфига
{
  const h = document.querySelector('header h1');
  const s = document.querySelector('header .sub');
  if (CFG.title) { h.textContent = CFG.title; document.title = CFG.title; }
  if (CFG.subtitle) s.textContent = CFG.subtitle; else s.remove();
}


const CARDS = [
  {k: 'speed', t: '⚡ Скорость', color: '#3ddc97', dual: true},
  {k: 'gpu', t: '🎛 Загрузка GPU', u: '%', color: '#3ddc97',
   q: `avg(nvml_gpu_utilization_percent{${JG}})`,
   raw: `nvml_gpu_utilization_percent{${JG}}`, fmt: 0,
   sub: (v, per) => per ? per.map(p => 'GPU' + p.m + ' ' + (+p.v[1]).toFixed(0) + '%').join(' · ') : ''},
  {k: 'vram', t: '🗂 Видеопамять', u: 'ГБ', color: '#3ddc97',
   q: `sum(nvml_gpu_memory_used_bytes{${JG}})/1073741824`,
   q2: `sum(nvml_gpu_memory_total_bytes{${JG}})/1073741824`,
   raw: `nvml_gpu_memory_used_bytes{${JG}}/1073741824`, fmt: 1,
   sub: (v, per, tot) => (per ? per.map(p => 'GPU' + p.m + ' ' + (+p.v[1]).toFixed(1)).join(' · ') + ' ГБ' : '') +
     (tot ? ' / ' + tot.toFixed(0) + ' ГБ' : '')},
  {k: 'temp', t: '🌡 Температура GPU', u: '°C', color: '#e8a33d',
   q: `max(nvml_gpu_temperature_celsius{${JG}})`,
   raw: `nvml_gpu_temperature_celsius{${JG}}`, fmt: 0,
   sub: (v, per) => per ? 'мин ' + Math.min(...per.map(p => +p.v[1])).toFixed(0) + '° · макс ' + Math.max(...per.map(p => +p.v[1])).toFixed(0) + '°' : ''},
  {k: 'pw', t: '🔌 Мощность', u: 'Вт', color: '#3ddc97',
   q: `sum(nvml_gpu_power_watts{${JG}})`,
   q2: `sum(nvml_gpu_power_limit_watts{${JG}})`, fmt: 0,
   sub: (v, per, tot) => tot ? 'из ' + tot.toFixed(0) + ' Вт (лимит)' : ''},
  {k: 'pcie', t: '🚌 Пропускная PCIe', u: 'МБ/с', color: '#a78bfa',
   q: `sum(nvml_pcie_throughput_kbytes_per_sec{${JG}})/1024`,
   q2: `sum by (direction) (nvml_pcie_throughput_kbytes_per_sec{${JG}})/1024`, fmt: 0,
   sub: (v, per, dirs) => {
     if (!dirs) return '';
     const rx = dirs.find(d => d.m.direction === 'rx'), tx = dirs.find(d => d.m.direction === 'tx');
     return 'RX ' + (rx ? (+rx.v[1]).toFixed(0) : '0') + ' · TX ' + (tx ? (+tx.v[1]).toFixed(0) : '0') + ' МБ/с';
   }},
  {k: 'ttft', t: '⏱ TTFT p95', u: 'с', color: '#4aa8e8',
   q: `histogram_quantile(0.95, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket{${JV}}[5m])))`, fmt: 2,
   sub: () => 'время до первого токена'},
  {k: 'cpu', t: '💽 Процессор', u: '%', color: '#3ddc97',
   q: `100 - avg(rate(node_cpu_seconds_total{${JN},mode="idle"}[60s]))*100`,
   q2: `avg(node_load1{${JN}})`, fmt: 0,
   sub: (v, per, load) => (load ? 'load 1m ' + load.toFixed(2) : '')},
  {k: 'disk', t: '💾 Диск чтение', u: 'МБ/с', color: '#4aa8e8',
   q: `sum(rate(node_disk_read_bytes_total{${JN}}[60s]))/1048576`,
   q2: `sum(rate(node_disk_written_bytes_total{${JN}}[60s]))/1048576`, fmt: 1,
   sub: (v, per, wr) => 'запись ' + (wr ? wr.toFixed(1) + ' МБ/с' : '')},
];

const KV = {
  kv: `max(vllm:kv_cache_usage_perc{${JV}})*100`,
  run: R('vllm:num_requests_running', '1m'), wait: R('vllm:num_requests_waiting', '1m'),
  pch: `sum(rate(vllm:prefix_cache_hits_total{${JV}}[5m]))/clamp_min(sum(rate(vllm:prefix_cache_queries_total{${JV}}[5m])),1e-9)*100`,
  mtp: `sum(rate(vllm:spec_decode_num_accepted_tokens_total{${JV}}[5m]))/clamp_min(sum(rate(vllm:generation_tokens_total{${JV}}[5m])),1e-9)*100`,
  ramU: `sum(node_memory_MemTotal_bytes{${JN}})-sum(node_memory_MemAvailable_bytes{${JN}})`,
  ramT: `sum(node_memory_MemTotal_bytes{${JN}})`,
};

// ===== построение карточек (паттерн Strata) =====
document.getElementById('cards').innerHTML = CARDS.map(c => {
  const big = c.dual
    ? `<div class="dual"><div><div class="big"><span id="v-dec">—</span><span class="u">ток/с</span></div><div class="sub">Генерация</div></div>` +
      `<div><div class="big"><span id="v-pre">—</span><span class="u">ток/с</span></div><div class="sub">Prefill</div></div></div>`
    : `<div class="big"><span id="v-${c.k}">—</span><span class="u">${c.u || ''}</span></div>` +
      (c.sub ? `<div class="sub" id="sub-${c.k}"></div>` : '');
  return `<div class="card"><div class="t">${c.t}</div>${big}` +
    `<svg class="spark" id="s-${c.k}" viewBox="0 0 100 32" preserveAspectRatio="none">` +
    `<path class="area" fill="${c.color}"/><path class="line" stroke="${c.color}"/></svg></div>`;
}).join('');

// ===== утилиты =====
async function jq(expr) {
  const r = await fetch(`${API}/query?query=${encodeURIComponent(expr)}`);
  if (!r.ok) throw new Error('prom ' + r.status);
  const j = await r.json();
  return j.data.result;
}
async function jqRange(expr) {
  const now = Math.floor(Date.now() / 1000);
  const mins = CFG.sparkMinutes, step = CFG.sparkStep;
  const r = await fetch(`${API}/query_range?query=${encodeURIComponent(expr)}` +
    `&start=${now - mins * 60}&end=${now}&step=${step}`);
  if (!r.ok) throw new Error('prom ' + r.status);
  const j = await r.json();
  return j.data.result.length ? j.data.result[0].values.map(v => +v[1]) : null;
}
function spark(id, values) {
  const svg = document.getElementById(id);
  if (!svg || !values || values.length < 2) return;
  const v = values.map(x => isFinite(x) ? Math.max(0, x) : 0);
  const top = Math.max(...v, 1e-9);
  const pts = v.map((x, i) => [(i / (v.length - 1)) * 100, 30 - (x / top) * 26]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('');
  svg.querySelector('.line').setAttribute('d', line);
  svg.querySelector('.area').setAttribute('d', `${line}L100,32L0,32Z`);
}
const last = {};
function txt(id, val) {
  val = String(val);
  if (last[id] === val) return;
  last[id] = val;
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function bar(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
}
const num = (v, d) => (v == null || !isFinite(v)) ? '—'
  : v.toLocaleString('ru', {maximumFractionDigits: d});

// ===== состояние модели (эвристика по метрикам vLLM) =====
let prevGen = '', genSince = 0;
function modelState(dec, pre, wait) {
  const st = (dec || 0) > 1 ? 'gen' : (wait || 0) > 0.5 ? 'queue'
    : (pre || 0) > 100 ? 'read' : 'idle';
  const now = Date.now();
  if (st === 'gen' && prevGen !== 'gen') genSince = now;
  prevGen = st;
  return {st, elapsed: st === 'gen' ? (now - genSince) / 1000 : 0};
}

// ===== опрос мгновенных значений =====
async function pollInstant() {
  const errEl = document.getElementById('err');
  try {
    const jobs = [{id: 'dec', e: R('vllm:generation_tokens_total')},
                  {id: 'pre', e: R('vllm:prompt_tokens_total')}];
    for (const c of CARDS) if (!c.dual) {
      jobs.push({id: c.k, e: c.q});
      if (c.q2) jobs.push({id: c.k + '_2', e: c.q2});
      if (c.raw) jobs.push({id: c.k + '_raw', raw: true, e: c.raw});
    }
    for (const k in KV) jobs.push({id: 'kv_' + k, e: KV[k]});
    const res = await Promise.all(jobs.map(j => jq(j.e)));
    const M = {};
    jobs.forEach((j, i) => M[j.id] = j.raw ? res[i]
      : res[i].length ? +res[i][0].value[1] : null);

    txt('v-dec', num(M.dec, 1)); txt('v-pre', num(M.pre, 0));
    for (const c of CARDS) {
      if (c.dual) continue;
      txt('v-' + c.k, num(M[c.k], c.fmt));
      if (c.sub) txt('sub-' + c.k, c.sub(M[c.k], M[c.k + '_raw'], M[c.k + '_2']));
    }

    // --- состояние ---
    const {st, elapsed} = modelState(M.dec, M.pre, M.kv_wait);
    ['idle', 'read', 'gen', 'queue', 'err'].forEach(p =>
      document.getElementById('p-' + p).classList.toggle('on', p === st));
    const names = {gen: 'Генерация', read: 'Чтение', queue: 'В очереди', idle: 'Простой'};
    txt('hdrState', names[st]); txt('hdrTok', num(M.dec, 1) + ' ток/с');
    document.getElementById('hdrDot').className = 'dot ' +
      (st === 'gen' ? 'g' : st === 'read' ? 'b' : st === 'queue' ? 'y' : '');
    txt('phase', st === 'gen' ? 'Думает (' + elapsed.toFixed(0) + ' с)'
        : st === 'read' ? 'Prefill промпта' : st === 'queue' ? 'Запросы ждут слота'
        : 'Ожидание запросов');
    txt('phaseMeta', 'в работе ' + num(M.kv_run, 0) + ' · в очереди ' + num(M.kv_wait, 0));
    bar('phaseBar', st === 'gen' ? Math.min(100, elapsed * 100 / 120) : st === 'idle' ? 0 : 50);

    // --- KV панель ---
    const kv = M.kv_kv;
    txt('fillPct', kv == null ? '—' : kv.toFixed(0) + '%');
    document.getElementById('ringArc').setAttribute('stroke-dashoffset', 440 - 440 * (kv || 0) / 100);
    txt('fillAbs', 'запущено ' + num(M.kv_run, 0) + ' · ожидает ' + num(M.kv_wait, 0));
    txt('v-pch', M.kv_pch == null ? '—' : M.kv_pch.toFixed(1) + '%'); bar('b-pch', M.kv_pch);
    const mtp = M.kv_mtp == null ? null : Math.min(100, M.kv_mtp);
    txt('v-mtp', mtp == null ? '—' : mtp.toFixed(1) + '%'); bar('b-mtp', mtp);
    if (M.kv_ramU != null && M.kv_ramT) {
      const u = M.kv_ramU / 1073741824, t = M.kv_ramT / 1073741824;
      txt('v-ram', u.toFixed(1) + ' / ' + t.toFixed(0) + ' ГБ'); bar('b-ram', u / t * 100);
    }
    txt('v-tempT', M.temp == null ? '—' : M.temp.toFixed(0) + ' °C'); bar('b-temp', M.temp);
    errEl.style.display = 'none';
  } catch (e) {
    errEl.textContent = '⚠ Prometheus недоступен: ' + e.message;
    errEl.style.display = 'block';
    ['idle', 'read', 'gen', 'queue', 'err'].forEach(p =>
      document.getElementById('p-' + p).classList.toggle('on', p === 'err'));
    document.getElementById('hdrDot').className = 'dot r';
    txt('hdrState', 'Нет связи');
  }
}

// ===== спарклайны (разреженный опрос) =====
async function pollRange() {
  try {
    const plain = CARDS.filter(c => !c.dual);
    const series = await Promise.all([
      jqRange(R('vllm:generation_tokens_total')),
      ...plain.map(c => jqRange(c.q)),
    ]);
    spark('s-speed', series[0]);
    plain.forEach((c, i) => spark('s-' + c.k, series[i + 1]));
  } catch (e) {/* разберёт pollInstant */}
}

pollInstant(); pollRange();
setInterval(pollInstant, CFG.refreshMs);
setInterval(pollRange, CFG.sparkRefreshMs);



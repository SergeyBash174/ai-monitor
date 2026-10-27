# ai-monitor

Живой монитор LLM-сервера в стиле [stratallm.org](https://stratallm.org/): скорость генерации
и prefill в токенах/сек, GPU (загрузка, память, температуры, мощность, PCIe), KV-кэш, TTFT,
CPU/диск — одна тёмная страница, обновляется раз в 2 секунды.

Всё self-hosted: Prometheus + лёгкий NVML-экспортёр + статическая страница. Никакого внешних
сервисов, никаких тяжёлых фронтенд-фреймворков.

## Архитектура

```
vLLM /metrics ─┐
node-exporter ─┼──▶ Prometheus (127.0.0.1:9090) ──▶ web/index.html + app.js
nvml-exporter ─┘            ▲                          (браузер, poll 2s)
  (NVML ctypes)             └── nginx vhost (статика + только /api/v1, allow-list)
```

- **exporter/nvml_exporter.py** — ~150 строк Python, грузит `libnvidia-ml.so.1` через `ctypes`
  (тот же приём, что у Strata) и отдаёт Prometheus-метрики: util, память, температуры, мощность,
  лимит мощности и **PCIe throughput** (которого нет в `nvidia-smi`). Ноль зависимостей:
  base image — `python:3.12-slim`, библиотека драйвера инжектится nvidia container runtime.
- **web/** — ванильный JS: декларативный массив карточек, SVG-спарклайны (15 строк),
  anti-flicker запись в DOM, состояние модели как стейт-машина по метрикам vLLM.
- **prometheus/** — scrape-конфиг (vLLM, node, NVML; LiteLLM опционально).
- **nginx/*.conf.example** — vhost'ы: статика + прокси **только** к `/api/v1` Prometheus,
  allow-list по подсетям. Скопируйте в `.conf` и впишите свои домены/подсети (файлы `.conf` в gitignore).
- **web/config.example.js** — персонализация страницы (заголовок, API base, имена job'ов,
  интервалы). Скопируйте в `web/config.js` (тоже в gitignore).

## Метрики на странице

| Карточка | Источник |
|---|---|
| ⚡ Скорость (генерация / prefill ток/с) | `vllm:generation_tokens_total` / `vllm:prompt_tokens_total` |
| 🎛 Загрузка GPU, 🗂 Видеопамять, 🌡 Температуры, 🔌 Мощность, 🚌 PCIe | `nvml_*` (собственный экспортёр) |
| ⏱ TTFT p95 | `vllm:time_to_first_token_seconds_bucket` |
| 💽 Процессор, 💾 Диск | node-exporter |
| Кольцо KV-кэша, prefix-cache hit, принятие MTP | `vllm:kv_cache_usage_perc`, `vllm:prefix_cache_*`, `vllm:spec_decode_*` |

## Быстрый старт

```bash
cp .env.example .env                  # пароли, теги образов, Grafana root URL
cp web/config.example.js web/config.js # заголовок страницы, API base, имена job'ов
cp nginx/monitor.conf.example nginx/monitor.conf  # домен + подсети allow-list
docker compose up -d                  # prometheus + grafana + node-exporter + nvml-exporter
sudo cp nginx/monitor.conf /etc/nginx/conf.d/ && sudo nginx -t && sudo systemctl reload nginx
# Grafana: http://<server>:3001 (пароль из .env), папка «LLM» — готовые дашборды vLLM
```

Страница открывается на вашем `monitor.<домен>` (или сразу `http://<server-ip>/`, если
настроить default vhost). Все личные адреса живут в файлах, которые в gitignore.

## Требования

- Linux с проприетарным драйвером NVIDIA (`/dev/nvidia*`, `libnvidia-ml.so.1` виден контейнеру
  через `runtime: nvidia` или монтирование библиотеки)
- Docker Compose v2, nginx на хосте (опционально — можно и `python -m http.server` в dev)
- vLLM ≥ 0.13 (метрики `vllm:*` с суффиксами `_total`; для более старых имён
  (`gpu_cache_usage_perc` без `vllm:`) поправьте выражения в `web/app.js` и Grafana-дашбордах)

## Dev

```bash
cd web && python3 -m http.server 8081     # если Prometheus доступен по CORS/туннелю
ssh -L 9090:127.0.0.1:9090 user@server    # пробросите Prometheus локально
# откройте http://localhost:8081
```

## Roadmap (v2)

- **Recent requests** — таблица последних запросов (per-request токены/тайминги): парсер логов
  vLLM → Loki, либо БД LiteLLM.
- Вкладка «Requests» в стиле инспектора Strata (drill-down по запросу).
- Алерты (alertmanager): рост очередей, перегрев, предemption-шторм.

## LICENSE

MIT

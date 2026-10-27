#!/usr/bin/env python3
"""NVML Prometheus exporter — zero-dependency GPU metrics via ctypes.

Inspired by the telemetry sampler of stratallm.org (serve/telemetry.py):
loads libnvidia-ml directly with ctypes, no pynvml / pip packages.

Serves Prometheus text exposition on LISTEN (default 127.0.0.1:9101):
  nvml_gpu_utilization_percent / memory_used|total_bytes / temperature_celsius
  nvml_gpu_power_watts / power_limit_watts / pcie_throughput_kbytes_per_sec
  nvml_pcie_link_generation_max / link_width_current / nvml_gpu_info / nvml_up
"""
import ctypes
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = os.environ.get("NVML_LISTEN", "127.0.0.1:9101")

NVML_SUCCESS = 0
NVML_TEMPERATURE_GPU = 0
NVML_PCIE_UTIL_TX_BYTES = 0
NVML_PCIE_UTIL_RX_BYTES = 1
NVML_DEVICE_NAME_BUFFER_SIZE = 1024


class Utilization(ctypes.Structure):
    _fields_ = [("gpu", ctypes.c_uint), ("memory", ctypes.c_uint),
                ("_reserved", ctypes.c_uint * 30)]


class Memory(ctypes.Structure):
    _fields_ = [("total", ctypes.c_ulonglong), ("free", ctypes.c_ulonglong),
                ("used", ctypes.c_ulonglong), ("_reserved", ctypes.c_ulonglong * 8)]


class Nvml:
    def __init__(self):
        self.lib = None
        self.handles = []
        self.names = []
        self.lock = threading.Lock()

    def load(self):
        for candidate in ("libnvidia-ml.so.1", "libnvidia-ml.so"):
            try:
                self.lib = ctypes.CDLL(candidate)
                break
            except OSError:
                continue
        if self.lib is None:
            return False
        if self.lib.nvmlInit_v2() != NVML_SUCCESS:
            self.lib = None
            return False
        count = ctypes.c_uint()
        if self.lib.nvmlDeviceGetCount_v2(ctypes.byref(count)) != NVML_SUCCESS:
            return False
        for i in range(count.value):
            h = ctypes.c_void_p()
            if self.lib.nvmlDeviceGetHandleByIndex_v2(i, ctypes.byref(h)) != NVML_SUCCESS:
                continue
            self.handles.append(h)
            self.names.append(self._name(h))
        return True

    def _name(self, h):
        buf = ctypes.create_string_buffer(NVML_DEVICE_NAME_BUFFER_SIZE)
        if self.lib.nvmlDeviceGetName(h, buf, NVML_DEVICE_NAME_BUFFER_SIZE) == NVML_SUCCESS:
            return buf.value.decode(errors="replace")
        return "unknown"

    def _uint(self, fn, *args):
        v = ctypes.c_uint()
        try:
            if getattr(self.lib, fn)(*(list(args) + [ctypes.byref(v)])) == NVML_SUCCESS:
                return v.value
        except (OSError, AttributeError):
            pass
        return None

    def sample(self):
        """Return list of dicts, one per GPU."""
        with self.lock:
            out = []
            for i, h in enumerate(self.handles):
                d = {"index": i, "name": self.names[i]}
                u = Utilization()
                if self.lib.nvmlDeviceGetUtilizationRates(h, ctypes.byref(u)) == NVML_SUCCESS:
                    d["util"] = u.gpu
                m = Memory()
                if self.lib.nvmlDeviceGetMemoryInfo(h, ctypes.byref(m)) == NVML_SUCCESS:
                    d["mem_used"] = m.used
                    d["mem_total"] = m.total
                d["temp"] = self._uint("nvmlDeviceGetTemperature", h, NVML_TEMPERATURE_GPU)
                pw = self._uint("nvmlDeviceGetPowerUsage", h)           # mW
                if pw is not None:
                    d["power_w"] = pw / 1000.0
                lim = self._uint("nvmlDeviceGetEnforcedPowerLimit", h)  # mW
                if lim is not None:
                    d["power_limit_w"] = lim / 1000.0
                rx = self._uint("nvmlDeviceGetPcieThroughput", h, NVML_PCIE_UTIL_RX_BYTES)
                tx = self._uint("nvmlDeviceGetPcieThroughput", h, NVML_PCIE_UTIL_TX_BYTES)
                if rx is not None:
                    d["pcie_rx_kb"] = rx
                if tx is not None:
                    d["pcie_tx_kb"] = tx
                gen = self._uint("nvmlDeviceGetMaxPcieLinkGeneration", h)
                if gen is not None:
                    d["pcie_gen_max"] = gen
                wid = self._uint("nvmlDeviceGetCurrPcieLinkWidth", h)
                if wid is not None:
                    d["pcie_width"] = wid
                out.append(d)
            return out


NVML = Nvml()



def render():
    lines = []

    def metric(name, help_text, samples, key, extra_labels=""):
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} gauge")
        for s in samples:
            v = s.get(key)
            if v is None:
                continue
            lines.append(f'{name}{{gpu="{s["index"]}"{extra_labels}}} {v}')

    gpus = []
    try:
        gpus = NVML.sample()
    except Exception as e:  # noqa: BLE001
        lines.append(f"# nvml sample error: {e}")

    lines.append("# HELP nvml_up 1 if NVML sampling succeeded")
    lines.append("# TYPE nvml_up gauge")
    lines.append(f"nvml_up {1 if gpus else 0}")

    metric("nvml_gpu_utilization_percent", "GPU utilization %", gpus, "util")
    metric("nvml_gpu_memory_used_bytes", "GPU memory used, bytes", gpus, "mem_used")
    metric("nvml_gpu_memory_total_bytes", "GPU memory total, bytes", gpus, "mem_total")
    metric("nvml_gpu_temperature_celsius", "GPU temperature, C", gpus, "temp")
    metric("nvml_gpu_power_watts", "GPU power draw, W", gpus, "power_w")
    metric("nvml_gpu_power_limit_watts", "GPU enforced power limit, W", gpus, "power_limit_w")

    lines.append("# HELP nvml_pcie_throughput_kbytes_per_sec PCIe throughput, KB/s")
    lines.append("# TYPE nvml_pcie_throughput_kbytes_per_sec gauge")
    for s in gpus:
        for direction, key in (("rx", "pcie_rx_kb"), ("tx", "pcie_tx_kb")):
            v = s.get(key)
            if v is not None:
                lines.append(f'nvml_pcie_throughput_kbytes_per_sec'
                             f'{{gpu="{s["index"]}",direction="{direction}"}} {v}')

    metric("nvml_pcie_link_generation_max", "Max PCIe link generation", gpus, "pcie_gen_max")
    metric("nvml_pcie_link_width_current", "Current PCIe link width (lanes)", gpus, "pcie_width")

    lines.append("# HELP nvml_gpu_info GPU name label carrier")
    lines.append("# TYPE nvml_gpu_info gauge")
    for s in gpus:
        lines.append(f'nvml_gpu_info{{gpu="{s["index"]}",name="{s["name"]}"}} 1')

    return ("\n".join(lines) + "\n").encode()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] not in ("/", "/metrics"):
            self.send_error(404)
            return
        body = render()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # quiet
        pass


def main():
    if not NVML.load():
        print("fatal: libnvidia-ml not found or nvmlInit failed", file=sys.stderr)
        sys.exit(1)
    print(f"nvml_exporter: {len(NVML.handles)} GPUs detected", file=sys.stderr)
    host, port = LISTEN.rsplit(":", 1)
    ThreadingHTTPServer((host, int(port)), Handler).serve_forever()


if __name__ == "__main__":
    main()

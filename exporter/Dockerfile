FROM python:3.12-slim
COPY nvml_exporter.py /app/nvml_exporter.py
USER 1000:1000
EXPOSE 9101
ENTRYPOINT ["python3", "/app/nvml_exporter.py"]

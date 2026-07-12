FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd --create-home --shell /usr/sbin/nologin celestial \
    && chown -R celestial:celestial /app
USER celestial

EXPOSE 8765

CMD ["uvicorn", "core.api_server:app", "--host", "0.0.0.0", "--port", "8765"]

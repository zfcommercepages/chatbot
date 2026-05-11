# storefront-chatbot (Python)

Zoho Commerce **AI chat proxy** (FastAPI) plus **widget client** maintained in this repo.

| Path | Purpose |
|------|---------|
| **`app/main.py`** | FastAPI: `GET /health`, `POST /api/chat`, serves **`/widget/*`** from `static/`. |
| **`static/`** | **`widget.css`** and **`widget.js`** — the live chat UI (edit here). |
| **`client/`** | Zoho theme snippets (`zoho-embed-hosted.html`, optional `store-widget-inline.html`). |

**Netlify / serverless** is **not** in this repo. Use the separate repository **`storefront-chatbot-netlify`** if you want that deployment shape.

## Run locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=... ALLOWED_ORIGINS=https://your-store.zohoecommerce.com
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 3000
```

- API: `http://localhost:3000/api/chat`
- Widget: `http://localhost:3000/widget/widget.js`

## Zoho

Paste **`client/zoho-embed-hosted.html`** before `</body>` (set `WIDGET_ASSET_BASE` to your deployed Python HTTPS URL).  
Or paste **`client/store-widget-inline.html`** for a single-file embed (no external widget assets).

## Deploy (Python)

Any host that runs **HTTPS** + **Python 3.10+** (Fly.io, Render, Railway, Docker, VPS). Set the same env vars as `.env.example`.

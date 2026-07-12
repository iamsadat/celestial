#!/bin/bash
set -e
echo "🚀 Setting up Celestial..."
pip install -r requirements.txt
echo "Dependencies installed. Then run:"
echo "  uvicorn core.api_server:app --port 8765"
echo "  python core/custom_proxy.py"
echo "  python core/browser_launcher.py <url>"

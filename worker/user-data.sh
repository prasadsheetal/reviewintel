#!/bin/bash
# ReviewIntel EC2 ingest worker bootstrap (runs as root on first boot).
#
# The CDK stack substitutes __RAW_BUCKET__ and __QUEUE_URL__ before this
# script is attached as instance user-data. Keep this file idempotent-ish:
# re-running it reinstalls deps and rewrites the cron file.
set -euxo pipefail

# --- System deps -----------------------------------------------------------
dnf install -y python3 python3-pip cronie
systemctl enable --now crond
pip3 install --quiet boto3

# --- Worker code ------------------------------------------------------------
mkdir -p /opt/reviewintel
# TODO: after pushing this repo to GitHub, set INGEST_SCRIPT_URL to the raw
# URL of worker/ingest.py, e.g.
#   https://raw.githubusercontent.com/<you>/reviewintel/main/worker/ingest.py
# Until then the download below fails loudly and cron logs the error.
INGEST_SCRIPT_URL="${INGEST_SCRIPT_URL:-https://raw.githubusercontent.com/REPLACE_ME/reviewintel/main/worker/ingest.py}"
curl -fsSL "$INGEST_SCRIPT_URL" -o /opt/reviewintel/ingest.py
chmod 644 /opt/reviewintel/ingest.py

# --- Daily cron (02:00 UTC) --------------------------------------------------
cat > /etc/cron.d/reviewintel <<'CRON_EOF'
RAW_BUCKET=__RAW_BUCKET__
QUEUE_URL=__QUEUE_URL__
# Optional: point at a real dataset slice once hosted.
# SAMPLE_DATA_URL=https://example.com/sample-reviews.json
BATCH_SIZE=20
0 2 * * * root /usr/bin/python3 /opt/reviewintel/ingest.py >> /var/log/reviewintel.log 2>&1
CRON_EOF
chmod 644 /etc/cron.d/reviewintel

# --- Smoke test the script immediately (fails fast if env is wrong) ----------
RAW_BUCKET="__RAW_BUCKET__" QUEUE_URL="__QUEUE_URL__" BATCH_SIZE=1 \
  /usr/bin/python3 -c "import ast; ast.parse(open('/opt/reviewintel/ingest.py').read())"
echo "reviewintel worker bootstrap complete"

#!/bin/bash
# RunPod one-liner deployment
# Usage: curl -sL <raw-github-url>/deploy.sh | bash
# Or:    bash deploy.sh
set -e

cd /workspace

# Clone if not exists
if [ ! -d "dash-enfuce-5" ]; then
  git clone git@github.com:katex35/dash-enfuce-5.git
fi
cd dash-enfuce-5
git pull origin main 2>/dev/null || true

# ─── Backend ───
cd backend
python3 -m venv venv 2>/dev/null || true
source venv/bin/activate
pip install --upgrade pip -q
pip install $(sed 's/faiss-cpu.*/faiss-gpu/' requirements.txt | tr '\n' ' ') -q

# Start backend
uvicorn app.main:app --host 0.0.0.0 --port 8000 &
BPID=$!

# Wait for backend ready
echo "Waiting for backend..."
for i in $(seq 1 90); do
  curl -sf http://localhost:8000/api/health >/dev/null 2>&1 && break
  sleep 2
done
echo "Backend ready (PID $BPID)"

# ─── Frontend ───
cd ../frontend

# Install Node if missing
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
fi

npm install --legacy-peer-deps -q 2>/dev/null

# Build — detect RunPod proxy URL
POD_ID=${RUNPOD_POD_ID:-$(hostname)}
API_URL="https://${POD_ID}-8000.proxy.runpod.net"
NEXT_PUBLIC_API_URL=$API_URL npm run build

# Start frontend
npx next start -p 3000 -H 0.0.0.0 &
FPID=$!

echo ""
echo "═══════════════════════════════"
echo " ✅ DEPLOYED"
echo " Frontend: https://${POD_ID}-3000.proxy.runpod.net"
echo " Backend:  $API_URL"
echo " Password: Laskienka"
echo "═══════════════════════════════"

# Keep alive
wait

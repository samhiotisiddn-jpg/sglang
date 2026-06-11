#!/data/data/com.termux/files/usr/bin/bash
# fm-triage.sh - FractalMesh fleet health triage (READ-ONLY)
# Sources ~/.secrets/fractal.env locally. Sends nothing off-device beyond the
# same provider auth checks your agents already make. Safe to re-run anytime.
#
# Usage (in Termux):  bash ~/fmsaas/fm-triage.sh
#
# Edit the var names in the KEY AUDIT block to match whatever your vault uses.

VAULT="${HOME}/.secrets/fractal.env"
if [ -f "$VAULT" ]; then set -a; . "$VAULT"; set +a; fi

echo "=== PROCESS AUDIT ==="
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist 2>/dev/null | python3 - <<'PY'
import sys, json, re, collections
try:
    data = json.load(sys.stdin)
except Exception:
    print("  (could not read pm2 jlist)"); sys.exit(0)
rows, base, total = [], collections.Counter(), 0
for p in data:
    name = p.get("name", "?")
    env  = p.get("pm2_env", {})
    mon  = p.get("monit", {})
    mem  = mon.get("memory", 0) or 0
    cpu  = mon.get("cpu", 0) or 0
    rt   = env.get("restart_time", 0)
    st   = env.get("status", "?")
    total += mem
    base[re.sub(r"-\d+$", "", name)] += 1
    rows.append((name, st, mem, cpu, rt))
for name, st, mem, cpu, rt in sorted(rows):
    print(f"  {name:26} {st:9} {mem/1048576:6.0f}MB  cpu{cpu:>3}%  restarts:{rt}")
print(f"\n  TOTAL: {len(rows)} processes, {total/1048576:.0f}MB RAM")
dups = [(b, c) for b, c in base.most_common() if c > 1]
if dups:
    print("\n  DUPLICATES (collapse each to 1 instance):")
    for b, c in dups:
        print(f"    {b}: {c} copies")
PY
else
  echo "  pm2 not found in PATH"
fi

echo
echo "=== KEY / ENDPOINT AUDIT ==="
chk() {
  local name="$1" url="$2" hdr="${3:-}"
  local args=(-s -o /dev/null -w '%{http_code}' --max-time 8)
  [ -n "$hdr" ] && args+=(-H "$hdr")
  local code; code=$(curl "${args[@]}" "$url" 2>/dev/null || echo 000)
  local s
  case "$code" in
    200|201) s="ALIVE";;
    401|403) s="DEAD-AUTH";;
    404)     s="BAD-URL";;
    405)     s="BAD-METHOD";;
    000)     s="NO-NET";;
    *)       s="HTTP $code";;
  esac
  printf "  %-12s %-10s (%s)\n" "$name" "$s" "$code"
}
chk OpenRouter https://openrouter.ai/api/v1/models          "Authorization: Bearer ${OPENROUTER_API_KEY:-}"
chk Groq       https://api.groq.com/openai/v1/models        "Authorization: Bearer ${GROQ_API_KEY:-}"
chk OpenAI     https://api.openai.com/v1/models             "Authorization: Bearer ${OPENAI_API_KEY:-}"
chk Mistral    https://api.mistral.ai/v1/models             "Authorization: Bearer ${MISTRAL_API_KEY:-}"
chk xAI        https://api.x.ai/v1/models                   "Authorization: Bearer ${XAI_API_KEY:-}"
chk Together   https://api.together.xyz/v1/models           "Authorization: Bearer ${TOGETHER_API_KEY:-}"
chk Cerebras   https://api.cerebras.ai/v1/models            "Authorization: Bearer ${CEREBRAS_API_KEY:-}"
chk Fireworks  https://api.fireworks.ai/inference/v1/models "Authorization: Bearer ${FIREWORKS_API_KEY:-}"
chk Stripe     https://api.stripe.com/v1/balance            "Authorization: Bearer ${STRIPE_API_KEY:-}"
chk Printful   https://api.printful.com/store               "Authorization: Bearer ${PRINTFUL_API_KEY:-}"
chk NASA       "https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY:-DEMO_KEY}"

echo
echo "  Note: Anthropic /v1/models needs header 'anthropic-version: 2023-06-01'."
echo "  A 405 means an agent is POSTing it — fix the method, not the key."

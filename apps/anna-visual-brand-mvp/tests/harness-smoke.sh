#!/bin/bash
# Smoke test: SPA UI harness end-to-end
# Tests window.hello, llm.complete, data flow, and that AI results match expected schema
set -e

echo "=== 1. Create session ==="
SESSION=$(curl -s -X POST "http://localhost:5190/api/session/create" -H "Content-Type: application/json" -d '{"wid":"smoke-test"}')
SID=$(echo "$SESSION" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['session_id'])")
echo "Session: $SID OK"

echo ""
echo "=== 2. window.hello ==="
HELLO=$(curl -s "http://localhost:5190/api/session/call" -H "Content-Type: application/json" -d "{\"session_id\":\"$SID\",\"kind\":\"req\",\"ns\":\"window\",\"method\":\"hello\",\"args\":{},\"id\":\"1\"}")
HELLO_OK=$(echo "$HELLO" | python3 -c "import json,sys; print('OK' if json.load(sys.stdin).get('ok') else 'FAIL')")
echo "hello: $HELLO_OK"

echo ""
echo "=== 3. llm.complete - brand analysis with color hints ==="
LLM_RESULT=$(curl -s "http://localhost:5190/api/session/call" -H "Content-Type: application/json" -d "{
  \"session_id\":\"$SID\",
  \"kind\":\"req\",
  \"ns\":\"llm\",
  \"method\":\"complete\",
  \"args\":{
    \"messages\":[{
      \"role\":\"system\",
      \"content\":\"You are a brand design AI assistant.\"
    },{
      \"role\":\"user\",
      \"content\":\"Analyze brand materials. Brand: Anna. User wants: LinkedIn poster about secure AI Agents. Style: extracted colors from design reference: #B84040, #E8D0D0, #404040, #D0D0D8, #F8F4F4. Extract colors, keywords, visual style. Return JSON with: summary, keywords, color_direction, primary_colors(name+hex+role), auxiliary_colors, logo_rules, visual_style(tone+composition+density+background), do, do_not, typography, confidence(style/color/layout/asset_rules). ONLY JSON.\"
    }],
    \"temperature\":0.3,
    \"max_tokens\":2000
  },
  \"id\":\"2\"
}")
LLM_OK=$(echo "$LLM_RESULT" | python3 -c "import json,sys; print('OK' if json.load(sys.stdin).get('ok') else 'FAIL')")
echo "llm.complete: $LLM_OK"

echo ""
echo "=== 4. Verify AI output structure ==="
AI_TEXT=$(echo "$LLM_RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
result = d.get('result', {})
content = result.get('content') or {}
text = content.get('text', '') if isinstance(content, dict) else ''
# Parse JSON from response
json_match = None
import re
m = re.search(r'```(?:json)?\s*\n?([\s\S]*?)\n?```', text)
if m: json_match = m.group(1)
else:
    m2 = re.search(r'\{[\s\S]*\}', text)
    if m2: json_match = m2.group(0)
if json_match:
    try:
        data = json.loads(json_match)
        print(json.dumps(data, indent=2))
    except:
        print('PARSE_ERROR:' + text[:200])
else:
    print('NO_JSON_FOUND:' + text[:200])
")

echo "$AI_TEXT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
errors = []

# Check required fields
if not data.get('primary_colors'):
    errors.append('MISSING primary_colors')
else:
    pc = data['primary_colors']
    print(f'  primary_colors: {len(pc)} items')
    for c in pc:
        hex_val = c.get('hex', '')
        if not hex_val.startswith('#') or len(hex_val) != 7:
            errors.append(f'INVALID hex: {hex_val}')
        else:
            print(f'    {c.get(\"name\",\"?\")} {hex_val} ({c.get(\"role\",\"?\")})')

if not data.get('summary'):
    errors.append('MISSING summary')
else:
    print(f'  summary: {data[\"summary\"][:80]}...')

if not data.get('keywords'):
    errors.append('MISSING keywords')
else:
    print(f'  keywords: {len(data[\"keywords\"])} items')

if not data.get('color_direction'):
    errors.append('MISSING color_direction')
else:
    print(f'  color_direction: {data[\"color_direction\"]}')

if not data.get('visual_style'):
    errors.append('MISSING visual_style')
else:
    vs = data['visual_style']
    print(f'  visual_style: tone={vs.get(\"tone\",\"?\")}, density={vs.get(\"density\",\"?\")}')

if not data.get('confidence'):
    errors.append('MISSING confidence')
else:
    conf = data['confidence']
    print(f'  confidence: style={conf.get(\"style\",\"?\")}, color={conf.get(\"color\",\"?\")}')

if errors:
    print(f'\n  ERRORS: {\", \".join(errors)}')
    sys.exit(1)
else:
    print(f'\n  ALL CHECKS PASSED')
"

echo ""
echo "=== 5. Check colors match input hints ==="
echo "$AI_TEXT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
input_colors = ['#B84040', '#E8D0D0', '#404040', '#D0D0D8', '#F8F4F4']
output_hexes = [c['hex'].upper() for c in data.get('primary_colors', [])]
output_hexes += [c['hex'].upper() for c in data.get('auxiliary_colors', [])]

# Check if at least one output color is in the input color range
matched = 0
for oh in output_hexes:
    for ic in input_colors:
        # Simple RGB distance check
        try:
            or_r = int(oh[1:3], 16); or_g = int(oh[3:5], 16); or_b = int(oh[5:7], 16)
            ir_r = int(ic[1:3], 16); ir_g = int(ic[3:5], 16); ir_b = int(ic[5:7], 16)
            dist = abs(or_r-ir_r) + abs(or_g-ir_g) + abs(or_b-ir_b)
            if dist < 80:
                print(f'  {oh} ~matches input {ic} (distance={dist})')
                matched += 1
                break
        except:
            pass
if matched >= 2:
    print(f'  Color match: OK ({matched} colors match input)')
else:
    print(f'  Color match: WEAK ({matched} colors match input)')
"

echo ""
echo "=== Smoke test complete ==="

# Return exit code
echo "$AI_TEXT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert data.get('primary_colors'), 'missing primary_colors'
assert data.get('summary'), 'missing summary'
assert data.get('visual_style'), 'missing visual_style'
print('ALL OK')
" 2>&1

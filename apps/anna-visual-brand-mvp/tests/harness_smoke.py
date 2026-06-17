#!/usr/bin/env python3
"""Automated smoke test for SPA UI harness with real LLM."""
import json, re, sys, urllib.request, urllib.error

BASE = "http://localhost:5190"

def call(sid, ns, method, args, req_id="1"):
    url = f"{BASE}/api/session/call"
    body = {"session_id": sid, "kind": "req", "ns": ns, "method": method, "args": args, "id": req_id}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())

def parse_json(text):
    """Extract JSON from AI response text."""
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass
    m = re.search(r'```(?:json)?\s*\n([\s\S]*?)\n```', text)
    if m:
        try: return json.loads(m.group(1).strip())
        except json.JSONDecodeError: pass
    m = re.search(r'\{[\s\S]*\}', text)
    if m:
        try: return json.loads(m.group(0))
        except json.JSONDecodeError: pass
    return None

def main():
    errors = []

    # 1. Create session
    req = urllib.request.Request(f"{BASE}/api/session/create", data=b'{"wid":"smoke"}', headers={"Content-Type": "application/json"})
    sess = json.loads(urllib.request.urlopen(req).read())
    sid = sess["session_id"]
    print(f"Session: {sid} OK")

    # 2. window.hello
    hello = call(sid, "window", "hello", {})
    assert hello.get("ok"), f"hello failed: {hello}"
    caps = hello.get("result", {}).get("scopes", hello.get("result", {}).get("capabilities", {}).get("scopes", []))
    print(f"Hello: OK, caps: {caps[:2] if caps else 'N/A'}")

    # 3. llm.complete with color hints
    llm = call(sid, "llm", "complete", {
        "messages": [{
            "role": "system",
            "content": "You are a brand design AI. Return only valid JSON."
        }, {
            "role": "user",
            "content": (
                "Analyze brand materials. Brand: Anna. "
                "User wants: LinkedIn poster about secure AI Agents. "
                "Extracted dominant colors from design reference: #B84040, #E8D0D0, #404040, #D0D0D8, #F8F4F4. "
                "Based on these colors and the brand context, extract: summary, keywords, color_direction, "
                "primary_colors (name+hex+role), auxiliary_colors (name+hex+role), logo_rules, "
                "visual_style (tone+composition+density+background), do (list), do_not (list), "
                "typography (headline+subheadline+body), confidence (style%+color%+layout%+asset_rules%). "
                "ONLY RETURN VALID JSON."
            )
        }],
        "temperature": 0.3,
        "max_tokens": 2000
    })
    assert llm.get("ok"), f"llm failed: {llm}"
    print(f"LLM: OK, model={llm['result'].get('model', '?')}")

    # 4. Parse and verify
    content = llm["result"].get("content", {})
    text = content.get("text", "") if isinstance(content, dict) else str(content)
    data = parse_json(text)
    assert data, f"Could not parse JSON from: {text[:300]}"
    print(f"Parsed JSON: {len(text)} chars")

    # Check required fields
    input_colors = ["#B84040", "#E8D0D0", "#404040", "#D0D0D8", "#F8F4F4"]

    for field in ["summary", "keywords", "color_direction", "primary_colors", "visual_style", "confidence"]:
        if not data.get(field):
            errors.append(f"MISSING: {field}")

    if data.get("primary_colors"):
        pc = data["primary_colors"]
        print(f"  primary_colors: {len(pc)} items")
        for c in pc:
            hex_val = c.get("hex", "")
            if not re.match(r'^#[0-9a-fA-F]{6}$', hex_val):
                errors.append(f"INVALID hex: {hex_val}")
            print(f"    {c.get('name', '?')} {hex_val} ({c.get('role', '?')})")

    # Check color relevance
    if data.get("primary_colors"):
        output_hexes = [c["hex"].upper() for c in data["primary_colors"]]
        matched = 0
        for oh in output_hexes:
            try:
                or_r, or_g, or_b = int(oh[1:3], 16), int(oh[3:5], 16), int(oh[5:7], 16)
                for ic in input_colors:
                    ir_r, ir_g, ir_b = int(ic[1:3], 16), int(ic[3:5], 16), int(ic[5:7], 16)
                    dist = abs(or_r - ir_r) + abs(or_g - ir_g) + abs(or_b - ir_b)
                    if dist < 100:
                        print(f"  Color match: {oh} ~= {ic} (distance={dist})")
                        matched += 1
                        break
            except (ValueError, IndexError):
                pass
        if matched < 2:
            errors.append(f"WEAK color match: only {matched} colors relate to input")
        else:
            print(f"  Color match: OK ({matched} colors match input)")

    # Check color direction makes sense
    cd = (data.get("color_direction") or "").lower()
    if "bold" not in cd and "high-contrast" not in cd and "contrast" not in cd:
        if not any(c in cd for c in ["bold", "vibrant", "dark", "deep"]):
            print(f"  color_direction: {data.get('color_direction')} (FYI - input colors suggest bold/dark)")

    print(f"  summary: {(data.get('summary') or '')[:80]}...")
    print(f"  keywords: {len(data.get('keywords') or [])} items")
    print(f"  density: {data.get('visual_style', {}).get('density', '?')}")
    print(f"  confidence: {data.get('confidence', {})}")

    if errors:
        print(f"\n  FAILED: {', '.join(errors)}")
        sys.exit(1)
    else:
        print(f"\n  ALL CHECKS PASSED")

if __name__ == "__main__":
    main()

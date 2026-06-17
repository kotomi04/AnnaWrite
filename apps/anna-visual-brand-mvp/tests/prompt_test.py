#!/usr/bin/env python3
"""Automated Prompt quality testing — generates Prompt via harness API, then evaluates it."""
import json
import re
import urllib.request
import sys

BASE = "http://localhost:5190"
OUTPUT_FILE = "/Users/qinghuasun/Documents/New project/anna-visual-brand-mvp/tests/test_results.jsonl"

TEST_CASES = [
    {
        "id": "A1-Anna-LinkedIn",
        "brand": "Anna",
        "platform": "LinkedIn",
        "designer": "social_media",
        "style_hint": "Professional, clean, tech-forward, premium muted blue palette, spacious composition, trustworthy feel. Brand blue (#1070d0) as primary accent on white (#ffffff) and light gray (#f0f0f0) backgrounds.",
        "user_request": "Create a LinkedIn post visual. The post announces: 'We gave Anna AI a browser and a local workspace. Anna connects cloud intelligence with the places where work actually happens: your browser, your local computer, and your files. That means Anna can research the web, read local documents, compare information, draft outputs, and help carry a task from request to completion. Not just a chat window. A working partner for real work.'",
        "image_colors": "#f0f0f0, #ffffff, #707070, #1070d0, #0060c0",  # from IMG_0074.PNG
    },
    {
        "id": "A2-Anna-Twitter",
        "brand": "Anna",
        "platform": "Twitter/X",
        "designer": "social_media",
        "style_hint": "Bold, eye-catching, brand blue (#1070d0) prominent, concise visual impact. White background with strong blue accents.",
        "user_request": "Create a Twitter/X post visual. The post announces: 'Let AI edit Word documents on your desktop. Anna brings professional Word editing to your local drafts. She can open your files, refine phrasing, leave context-aware comments, standardize formatting, and restructure documents — right where your work already lives. Less line-by-line proofreading. Less formatting fatigue. More done. Read more: anna.partners/docs#refactor-docs'",
        "image_colors": "#f0f0f0, #ffffff, #707070, #1070d0, #0060c0",
    },
    {
        "id": "A3-Anna-ArticleHero",
        "brand": "Anna",
        "platform": "Website Hero",
        "designer": "concept",
        "style_hint": "Abstract concept illustration. Low information density, atmospheric, metaphorical. Subtle blue tones (#1070d0, #0060c0) used as mood, not decoration. Large negative space. Quiet futurism aesthetic.",
        "user_request": "Create a website hero image for an article about SAA (Software as Agent). The visual should be abstract and conceptual — representing AI as a working partner, not just a chat interface. Think: cloud intelligence connecting to local workspace, browser, files. Calm, premium, tech-forward atmosphere.",
        "image_colors": "#f0f0f0, #ffffff, #707070, #1070d0, #0060c0",
    },
    {
        "id": "C1-Claude-LegalArticle",
        "brand": "Claude",
        "platform": "Website Hero",
        "designer": "concept",
        "style_hint": "Abstract legal concept illustration. Purple-toned (like Claude's brand). Professional authority, trust. Clean composition with geometric precision. Low information density. Concept art style.",
        "user_request": "Create a website hero image for an article about deploying Claude across the legal industry. The article covers: contract review, M&A diligence, privacy assessments, regulatory monitoring, litigation prep. 87% of general counsel now use generative AI. The visual should convey legal expertise + AI innovation in an abstract, conceptual way.",
        "image_colors": "#E8D5FF, #FFFFFF, #2D2640, #8B6FCC, #5C4699",  # Claude purple palette
    },
    {
        "id": "C2-Claude-LinkedIn",
        "brand": "Claude",
        "platform": "LinkedIn",
        "designer": "social_media",
        "style_hint": "Inspirational, approachable, Claude's purple brand palette. Spacious composition. The idea: starting a project you haven't started yet. Warm, encouraging tone with professional polish.",
        "user_request": "Create a LinkedIn post visual. The post message is: 'Everyone has a project they haven\\'t started yet. When you\\'re ready, so is Claude.' The visual should feel inspiring and approachable — encouraging people to start their creative projects with AI assistance. Purple Claude brand palette, clean composition, warmth.",
        "image_colors": "#E8D5FF, #FFFFFF, #2D2640, #8B6FCC, #5C4699",
    },
]


def call(sid, ns, method, args, rid="1"):
    body = {"session_id": sid, "kind": "req", "ns": ns, "method": method, "args": args, "id": rid}
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}/api/session/call", data=data, headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())


def parse(text):
    try: return json.loads(text.strip())
    except: pass
    m = re.search(r"```(?:json)?\s*\n([\s\S]*?)\n```", text)
    if m:
        try: return json.loads(m.group(1).strip())
        except: pass
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try: return json.loads(m.group(0))
        except: pass
    return None


def create_session():
    req = urllib.request.Request(f"{BASE}/api/session/create", data=b'{"wid":"test"}', headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())["session_id"]


def run_analysis(sid, tc):
    """Simulate aiAnalyzeMaterials via llm.complete"""
    prompt = f"""Analyze the following brand materials and extract a structured brand profile.

Brand name: {tc["brand"]}
User wants to create: {tc["user_request"][:100]}
Target platform: {tc["platform"]}
Style preferences: {tc["style_hint"]}
Designer type: {tc["designer"]}
Extracted dominant colors from design image: {tc["image_colors"]}

Based on the brand name, style preferences and designer type, extract:
1. summary, 2. keywords, 3. avoid_keywords, 4. color_direction, 5. primary_colors (name+hex+role+coverage%), 
6. auxiliary_colors, 7. color_rules, 8. logo_rules, 9. visual_style (tone+composition+density+background),
10. do, 11. do_not, 12. typography, 13. confidence

Return ONLY valid JSON."""

    system = "You are a senior brand design director. Return valid JSON with precise hex codes."
    result = call(sid, "llm", "complete", {
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "temperature": 0.3, "max_tokens": 3000
    }, "analyze")
    if not result.get("ok"):
        return None
    content = result["result"]["content"]
    text = content.get("text", str(content))
    return parse(text)


def run_visual_prompt(sid, tc, analysis_data):
    """Simulate aiGenerateVisualPrompt"""
    designer_system = {
        "social_media": "You are a senior social media art director. You create platform-native visuals with bold brand colors, clear information hierarchy, and professional polish. Your prompts specify exact compositions, color proportions, lighting, and material treatments.",
        "concept": "You are a senior concept illustrator. You create abstract, atmospheric concept images with subtle use of brand colors, large negative space, and metaphorical visual language. Your prompts emphasize mood, light, and spatial poetry over literal representation.",
    }[tc["designer"]]

    colors = analysis_data.get("color_system", {}) if analysis_data else {}
    prompt = f"""Write a precise image generation prompt based on this brand design brief:

USER REQUEST: {tc["user_request"]}
PLATFORM: {tc["platform"]}
DESIGNER TYPE: {tc["designer"]}

BRAND SPECS:
- Primary colors: {json.dumps(colors.get("primary_colors", []) if isinstance(colors, dict) else [])}
- Accent colors: {json.dumps(colors.get("auxiliary_colors", []) if isinstance(colors, dict) else [])}
- Color direction: {colors.get("overall_direction", "") if isinstance(colors, dict) else ""}

Include in the prompt:
1. Composition — exact spatial layout with proportions
2. Color proportions — specific area ratios
3. Lighting — source direction and quality
4. Material — surface treatment
5. Execution — always generate background+hero first, overlay logo/text separately
6. What to avoid — specific prohibitions

Return ONLY JSON:
{{
  "visual": {{
    "visual_id": "visual_...",
    "platform": "...",
    "user_request": "...",
    "prompt": "...",
    "negative_instructions": [...],
    "compliance_explanation": "...",
    "preview": {{"headline": "...", "palette": ["#...","#..."], "layout": "..."}}
  }}
}}"""

    result = call(sid, "llm", "complete", {
        "messages": [{"role": "system", "content": designer_system}, {"role": "user", "content": prompt}],
        "temperature": 0.4, "max_tokens": 2500
    }, "visual")
    if not result.get("ok"):
        return None
    content = result["result"]["content"]
    text = content.get("text", str(content))
    return parse(text)


def run_all_tests():
    results = []
    sid = create_session()
    print(f"Session: {sid}")
    print(f"Running {len(TEST_CASES)} test cases...\n")

    for i, tc in enumerate(TEST_CASES):
        print(f"[{i+1}/{len(TEST_CASES)}] {tc['id']}")
        print(f"  Brand: {tc['brand']}, Platform: {tc['platform']}, Designer: {tc['designer']}")

        # Step 1: Brand analysis
        analysis = run_analysis(sid, tc)
        if not analysis:
            print(f"  FAIL: Could not analyze brand\n")
            results.append({**tc, "error": "analysis_failed"})
            continue

        # Step 2: Visual prompt generation
        visual = run_visual_prompt(sid, tc, analysis)
        if not visual:
            print(f"  FAIL: Could not generate visual prompt\n")
            results.append({**tc, "error": "visual_failed"})
            continue

        v = visual.get("visual", {})
        preview = v.get("preview", {})
        palette = preview.get("palette", [])
        prompt_text = v.get("prompt", "")

        # Evaluate
        color_match = all(re.match(r"^#[0-9a-fA-F]{6}$", c) for c in palette)
        has_composition = any(w in prompt_text.lower() for w in ["composition", "layout", "spatial", "proportion", "rule of thirds"])
        has_lighting = any(w in prompt_text.lower() for w in ["lighting", "light", "shadow", "diffuse", "studio"])
        has_material = any(w in prompt_text.lower() for w in ["material", "texture", "surface", "matte", "glass", "frosted"])
        has_color_ratio = any(w in prompt_text.lower() for w in ["%", "percent", "proportion", "ratio"])
        prompt_length = len(prompt_text)

        score = sum([color_match, has_composition, has_lighting, has_material, has_color_ratio])
        grade = "A" if score >= 5 else "B" if score >= 3 else "C"

        print(f"  Grade: {grade} | Colors: {len(palette)} | Prompt: {prompt_length} chars")
        print(f"  Checks: composition={has_composition} lighting={has_lighting} material={has_material} color_ratio={has_color_ratio}")
        print(f"  Palette: {palette[:3]}")
        print(f"  Headline: {preview.get('headline', 'N/A')[:60]}")
        print(f"  Prompt excerpt: {prompt_text[:150]}...")
        print()

        results.append({
            **tc,
            "grade": grade,
            "score": score,
            "palette": palette,
            "headline": preview.get("headline", ""),
            "layout": preview.get("layout", ""),
            "prompt": prompt_text,
            "prompt_length": prompt_length,
            "checks": {
                "color_match": color_match,
                "has_composition": has_composition,
                "has_lighting": has_lighting,
                "has_material": has_material,
                "has_color_ratio": has_color_ratio,
            },
        })

    # Save results
    with open(OUTPUT_FILE, "w") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    # Print summary
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    grades = [r.get("grade", "F") for r in results]
    a_count = grades.count("A")
    b_count = grades.count("B")
    c_count = grades.count("C")
    f_count = grades.count("F")
    print(f"A: {a_count}  B: {b_count}  C: {c_count}  F: {f_count}")
    print(f"Total: {len(results)}")
    print(f"Results saved to: {OUTPUT_FILE}")

    # Print full prompts for copy-paste
    print("\n" + "=" * 60)
    print("FULL PROMPTS (copy to Anna chat for image generation)")
    print("=" * 60)
    for r in results:
        if r.get("prompt"):
            print(f"\n--- {r['id']} (Grade: {r.get('grade', 'N/A')}) ---")
            print(r["prompt"])
            print("---END---")

    return results


if __name__ == "__main__":
    run_all_tests()

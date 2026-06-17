#!/usr/bin/env python3
"""AnnaVisual Brand MVP — Executa v1 stdio tool plugin (JSON-RPC over stdin/stdout).

Returns mock data for all 4 tools. LLM analysis is handled by the frontend
via anna.llm.complete() — this plugin provides structured fallback responses.
"""
from __future__ import annotations

import json
import select
import sys
import time
from typing import Any

TOOL_ID = "tool-qinghuasun-annavisual-brand-mvp-j6sdhjxy"

MANIFEST: dict[str, Any] = {
    "name": TOOL_ID,
    "display_name": "AnnaVisual Brand MVP",
    "version": "1.1.0",
    "description": "Guided brand visual creation — analyze materials, generate visual_manual JSON, create brand-constrained visuals, save references.",
    "author": "AnnaVisual",
    "homepage": "https://staging.anna.partners/developer",
    "license": "Proprietary",
    "host_capabilities": ["llm.image", "llm.image.edit", "host.upload"],
    "tags": ["brand", "visual-generation", "mvp", "anna", "guided", "visual-manual"],
    "tools": [
        {
            "name": "analyze_brand_material",
            "description": "Analyze uploaded brand source files and user input, extract brand identity.",
            "parameters": [
                {"name": "source_files", "type": "array", "items": {"type": "object"}, "description": "Uploaded brand source files metadata.", "required": False},
                {"name": "brand_hint", "type": "string", "description": "Brand name or direction.", "required": False},
                {"name": "user_request", "type": "string", "description": "What kind of visual to create.", "required": False},
                {"name": "platform", "type": "string", "description": "Target channel.", "required": False},
                {"name": "style_description", "type": "string", "description": "User's style preferences.", "required": False},
                {"name": "reference_intake", "type": "object", "description": "User answers to intake questions.", "required": False},
                {"name": "material_evidence", "type": "object", "description": "Local image/PDF design evidence including composition, elements, materials, and transfer rules.", "required": False},
            ],
        },
        {
            "name": "generate_brand",
            "description": "Generate a full visual_manual JSON from analyzed context.",
            "parameters": [
                {"name": "brand_hint", "type": "string", "description": "Brand name.", "required": False},
                {"name": "user_request", "type": "string", "description": "User's visual request.", "required": False},
                {"name": "platform", "type": "string", "description": "Target platform.", "required": False},
                {"name": "analyzed_context", "type": "object", "description": "Result from analyze_brand_material.", "required": False},
            ],
        },
        {
            "name": "create_visual",
            "description": "Create a brand-constrained generation instruction from a visual_manual.",
            "parameters": [
                {"name": "visual_manual", "type": "object", "description": "Confirmed visual_manual JSON.", "required": True},
                {"name": "user_request", "type": "string", "description": "What to generate.", "required": True},
                {"name": "platform", "type": "string", "description": "Target channel.", "required": False},
            ],
        },
        {
            "name": "save_reference",
            "description": "Save a generated result as a Brand Reference.",
            "parameters": [
                {"name": "brand_id", "type": "string", "description": "Brand identifier.", "required": True},
                {"name": "visual", "type": "object", "description": "Visual result to save.", "required": True},
            ],
        },
        {
            "name": "generate_image",
            "description": "Generate a raster image through Anna host image generation using the final Brand + Designer prompt package.",
            "parameters": [
                {"name": "package", "type": "object", "description": "Compact Brand + Designer image package.", "required": True},
                {"name": "prompt", "type": "string", "description": "Final image prompt.", "required": True},
                {"name": "size", "type": "string", "description": "Requested output size, e.g. 1024x1024.", "required": False},
                {"name": "reference_image_urls", "type": "array", "items": {"type": "string"}, "description": "Optional uploaded reference image URLs.", "required": False},
                {"name": "reference_images", "type": "array", "items": {"type": "object"}, "description": "Optional inline reference images when the host accepts data URLs.", "required": False},
                {"name": "n", "type": "integer", "description": "Number of images.", "required": False},
                {"name": "modelPreferences", "type": "object", "description": "Optional model preference hints.", "required": False},
                {"name": "metadata", "type": "object", "description": "Generation metadata.", "required": False},
            ],
        },
        {
            "name": "edit_image",
            "description": "Edit a generated image through Anna host image editing while preserving Brand + Designer constraints.",
            "parameters": [
                {"name": "package", "type": "object", "description": "Compact Brand + Designer image package.", "required": False},
                {"name": "image_url", "type": "string", "description": "Image URL to edit.", "required": True},
                {"name": "prompt", "type": "string", "description": "Edit instruction.", "required": True},
                {"name": "mask_url", "type": "string", "description": "Optional mask URL.", "required": False},
                {"name": "n", "type": "integer", "description": "Number of edited images.", "required": False},
                {"name": "metadata", "type": "object", "description": "Edit metadata.", "required": False},
            ],
        },
    ],
    "runtime": {"type": "uv", "min_version": "0.1.0"},
}

PROTOCOL_V2_NEGOTIATED = False


# ── Tool implementations ──

def _embedded_json_after_marker(text: str, marker: str) -> dict:
    idx = text.rfind(marker)
    if idx < 0:
        return {}
    start = text.find("{", idx)
    if start < 0:
        return {}
    try:
        parsed, _ = json.JSONDecoder().raw_decode(text[start:])
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _material_evidence_from_args(args: dict, style_desc: str) -> dict:
    evidence = args.get("material_evidence")
    if isinstance(evidence, dict):
        return evidence
    return _embedded_json_after_marker(style_desc, "--- Material Evidence ---")


def _palette_from_evidence(evidence: dict) -> list[str]:
    colors: list[str] = []
    for image in evidence.get("images") or []:
        for color in image.get("palette") or []:
            hex_value = str(color.get("hex") or "").upper()
            if hex_value.startswith("#") and len(hex_value) == 7 and hex_value not in colors:
                colors.append(hex_value)
    return colors


def _local_design_summary(evidence: dict, user_request: str) -> dict:
    summary = evidence.get("design_summary") if isinstance(evidence.get("design_summary"), dict) else {}
    observations = []
    for image in evidence.get("images") or []:
        reading = image.get("design_reading")
        if isinstance(reading, dict):
            observations.append(reading)
        else:
            palette = ", ".join(f"{c.get('hex')} {c.get('coverage', '')}".strip() for c in image.get("palette") or [])
            observations.append({
                "source": image.get("file_name", "uploaded image"),
                "screen_content": f"Uploaded visual reference, {image.get('dimensions', {})}, aspect {image.get('aspect_ratio', '?')}.",
                "composition": "Use the uploaded image as style evidence; preserve spacing rhythm and visual hierarchy without copying the exact layout.",
                "main_visual_elements": ["source surface rhythm", "brand palette roles", "controlled focal hierarchy"],
                "typography_layout": "Keep final typography editable; do not bake small source text into generation.",
                "brand_assets": ["treat visible logo/mascot conservatively as fixed overlay assets"],
                "color_proportion": palette,
                "materials_lighting": "source-led surface and lighting treatment",
                "transferable_rules": ["Preserve source composition rhythm", "Use source palette roles", "Translate source visual elements into a new layout"],
                "do_not_copy": ["Do not copy exact screenshot layout", "Do not generate fake logos", "Do not hallucinate source text"],
                "relevance_to_user_request": f"Use as brand evidence for: {user_request}" if user_request else "Use as brand/style evidence.",
            })
    visual_elements = summary.get("visual_elements") or []
    if not visual_elements:
        for item in observations:
            visual_elements.extend(item.get("main_visual_elements") or item.get("main_elements") or [])
    transfer_rules = summary.get("transferable_rules") or []
    if not transfer_rules:
        for item in observations:
            transfer_rules.extend(item.get("transferable_rules") or [])
    do_not_copy = summary.get("do_not_copy_rules") or []
    if not do_not_copy:
        for item in observations:
            do_not_copy.extend(item.get("do_not_copy") or [])
    composition_dna = summary.get("composition_dna") or []
    if not composition_dna:
        for item in observations:
            composition_dna.extend(item.get("composition_dna") or (item.get("photo_design_reading") or {}).get("composition_dna") or [])
    photographic_prompt_rules = summary.get("photographic_prompt_rules") or []
    if not photographic_prompt_rules:
        for item in observations:
            photographic_prompt_rules.extend(item.get("photographic_prompt_rules") or [])
    photo_readings = summary.get("photography_and_surface_reading") or {}
    return {
        "overall_style": summary.get("overall_style") or "Source-led brand visual system",
        "composition": summary.get("composition") or "; ".join(o.get("composition", "") for o in observations if o.get("composition")),
        "visual_elements": list(dict.fromkeys(visual_elements))[:10],
        "textures_materials": summary.get("textures_materials") or [],
        "lighting_depth": summary.get("lighting_depth") or "",
        "typography_hierarchy": summary.get("typography_hierarchy") or "",
        "image_specific_observations": observations,
        "photography_and_surface_reading": photo_readings,
        "composition_dna": list(dict.fromkeys(composition_dna))[:12],
        "photographic_prompt_rules": list(dict.fromkeys(photographic_prompt_rules))[:12],
        "transferable_rules": list(dict.fromkeys(transfer_rules))[:12],
        "do_not_copy_rules": list(dict.fromkeys(do_not_copy))[:12],
    }


def _analyze_brand_material(args: dict) -> dict:
    brand_hint = str(args.get("brand_hint") or "Untitled").strip()
    user_request = str(args.get("user_request") or "").strip()
    platform = str(args.get("platform") or "LinkedIn").strip()
    style_desc = str(args.get("style_description") or "").strip()
    source_files = args.get("source_files") or []
    intake = args.get("reference_intake") or {}
    material_evidence = _material_evidence_from_args(args, style_desc)
    design_summary = _local_design_summary(material_evidence, user_request)

    # Extract hex colors from style_description text
    import re
    hexes = _palette_from_evidence(material_evidence) or re.findall(r'#[0-9a-fA-F]{6}', style_desc)
    primary_colors = [
        {"name": "Extracted Color 1", "hex": hexes[0] if len(hexes) > 0 else "#F2F0F1", "role": "background", "notes": ["From design image"]},
        {"name": "Extracted Color 2", "hex": hexes[1] if len(hexes) > 1 else "#DDD7E2", "role": "secondary surface", "notes": ["From design image"]},
        {"name": "Extracted Color 3", "hex": hexes[2] if len(hexes) > 2 else "#E8C7D0", "role": "accent", "notes": ["From design image"]},
    ]
    aux_colors = [
        {"name": "Extracted Color 4", "hex": hexes[3] if len(hexes) > 3 else "#17151C", "role": "text", "notes": ["From design image"]},
    ]

    vm = {
        "metadata": {
            "project_name": brand_hint,
            "document_title": f"Visual Manual — {brand_hint}",
            "version": "1.1.0",
            "date": time.strftime("%Y-%m-%d"),
            "source_type": f"{len(source_files)} reference files" if source_files else "no reference files",
            "reference_count": len(source_files),
            "confidence": {"style": "85%", "color": "90%", "layout": "80%", "asset_rules": "90%"},
        },
        "interpretation_policy": {
            "extract": ["Image content", "Color palette", "Composition structure", "Main visual elements", "Typography/layout", "Materials/lighting", "Transferable rules"],
            "do_not_copy": ["Exact pixel layout", "Business semantics", "Logo as generated object"],
            "not_specified": ["Exact font files"],
        },
        "reference_intake": {
            "purpose": f"Brand intake for {brand_hint}" + (f": {intake.get('asset_identity', '')}" if intake else ""),
            "user_answers": intake,
            "fallback_process": ["Ask user to clarify"],
        },
        "visual_identity": {
            "core_impression": {
                "keywords": ["professional", "clean", "modern", "structured"],
                "avoid_keywords": ["cartoonish", "neon", "chaotic"],
                "summary": f"{brand_hint} is a professional brand with clean, modern visual language." if brand_hint != "Untitled" else "A professional brand with clean modern aesthetic.",
            },
            "visual_language": {"characteristics": design_summary.get("visual_elements") or ["Spacious composition", "Restrained palette"], "avoid": design_summary.get("do_not_copy_rules") or ["Cluttered layouts", "High saturation"]},
        },
        "color_system": {
            "overall_direction": "Muted professional",
            "primary_colors": primary_colors,
            "auxiliary_colors": aux_colors,
            "combination_rules": {"preferred": ["High contrast for readability"], "avoid": ["Neon on muted backgrounds"]},
        },
        "asset_rules": {
            "logo": {"policy": "fixed_asset_overlay", "preferred_usage": ["Use exact logo as overlay"], "avoid": ["Do not generate or redraw"]},
            "mascot_or_key_asset": {"policy": "fixed_mascot_overlay", "preferred_usage": ["Use exact asset as overlay"], "avoid": ["Do not distort"]},
        },
        "typography_and_layout": {
            "text_strategy": {"density": "low_to_medium", "preferred_structure": ["Bold headline", "Short subheadline"], "avoid": ["Long paragraphs"]},
            "typography": {
                "headline": "Modern sans-serif, bold",
                "subheadline": "Regular sans-serif",
                "body_or_small_text": "Minimal usage",
                "chinese": {"title_font": "Source Han Sans Bold", "body_font": "Source Han Sans Regular"},
                "english": {"title_font": "Inter Bold", "subtitle_font": "Inter SemiBold", "body_font": "Inter Regular", "notes": "Geometric sans-serif"},
            },
            "composition": {"preferred": ["Single hero visual", "Logo overlay layer"], "avoid": ["Grid layouts", "Text-heavy sections"], "variation_rules": ["Vary hero placement"]},
        },
        "application_scenarios": [{"scenario": platform or "LinkedIn", "purpose": f"{platform or 'LinkedIn'} brand visual", "recommended_elements": ["Clean composition"], "avoid": ["Clutter"]}],
        "generation_rules": {
            "workflow": ["1. Generate background", "2. Review", "3. Overlay logo and text"],
            "prompt_template": f"Create a {platform or 'LinkedIn'} visual for {brand_hint}. Include Visual evidence, Transfer rules, Composition, Color system, Lighting, Materials, and Overlay plan.",
            "do": ["Use brand colors", "Keep spacing generous", "Maintain hierarchy"] + design_summary.get("transferable_rules", [])[:4],
            "negative_prompt": ["no neon", "no generated logo", "no high saturation"] + design_summary.get("do_not_copy_rules", [])[:5],
            "execution_notes": ["Separate bg from overlay", "Logo and mascot are fixed assets"],
            "prompt_blueprint": {
                "central_metaphor": "translate the user request into a source-faithful brand visual metaphor",
                "hero_subject": user_request or "brand-compliant hero visual",
                "supporting_elements": design_summary.get("visual_elements", [])[:6],
                "platform_fit": platform,
                "text_overlay_strategy": "keep exact text, logo, and mascot as editable overlays when required",
                "composition": design_summary.get("composition") or "source-led composition rhythm adapted to target platform",
                "color_ratio": "use source palette roles and proportions from uploaded evidence",
                "lighting": design_summary.get("lighting_depth") or "source-led lighting and depth",
                "materials": ", ".join(design_summary.get("textures_materials", [])[:5]) or "source-led surface/material treatment",
                "camera_or_perspective": "match source perspective logic unless user request requires a different format",
            },
        },
        "material_analysis": {
            "overall_style": design_summary.get("overall_style"),
            "design_philosophy": "Use uploaded images/PDFs as design evidence, not just color samples.",
            "composition": design_summary.get("composition"),
            "visual_elements": design_summary.get("visual_elements"),
            "textures_materials": design_summary.get("textures_materials"),
            "lighting_depth": design_summary.get("lighting_depth"),
            "typography_hierarchy": design_summary.get("typography_hierarchy"),
            "image_specific_observations": design_summary.get("image_specific_observations"),
            "photography_and_surface_reading": design_summary.get("photography_and_surface_reading", {}),
            "composition_dna": design_summary.get("composition_dna", []),
            "photographic_prompt_rules": design_summary.get("photographic_prompt_rules", []),
            "transferable_rules": design_summary.get("transferable_rules"),
            "do_not_copy_rules": design_summary.get("do_not_copy_rules"),
            "evidence_summary": material_evidence,
        },
        "review_checklist": {
            "style": ["Color matches intent", "Tone aligns with brand"],
            "color": ["Primary colors correct", "No banned combos"],
            "assets": ["Logo policy defined", "Mascot policy defined"],
            "layout": ["Composition correct", "Text density correct"],
            "content": ["User request captured", "Platform correct"],
        },
    }
    return {"visual_manual": vm, "confidence": vm["metadata"]["confidence"]}


def _generate_brand(args: dict) -> dict:
    ctx = args.get("analyzed_context") or {}
    vm = ctx.get("visual_manual")
    if vm:
        vm["metadata"]["date"] = time.strftime("%Y-%m-%d")
        return {"visual_manual": vm, "review_gate": ["Confirm color direction", "Confirm typography", "Confirm density"], "summary": "Visual Manual ready. Review before confirming."}
    brand_hint = str(args.get("brand_hint") or "Untitled").strip()
    platform = str(args.get("platform") or "LinkedIn").strip()
    return _analyze_brand_material({"brand_hint": brand_hint, "user_request": args.get("user_request", ""), "platform": platform})


def _create_visual(args: dict) -> dict:
    vm = args.get("visual_manual") or {}
    user_request = str(args.get("user_request") or "").strip()
    platform = str(args.get("platform") or "LinkedIn").strip()
    brand_name = vm.get("metadata", {}).get("project_name", "Untitled")
    colors = vm.get("color_system", {})
    palette = [c.get("hex", "#F2F0F1") for c in (colors.get("primary_colors", []) + colors.get("auxiliary_colors", []))]
    request = vm.get("request_interpretation", {})
    material = vm.get("material_analysis", {})
    generation = vm.get("generation_rules", {})
    blueprint = generation.get("prompt_blueprint", {})
    typo_layout = vm.get("typography_and_layout", {})
    density = typo_layout.get("text_strategy", {}).get("density", "low_to_medium")
    composition = blueprint.get("composition") or "; ".join(typo_layout.get("composition", {}).get("preferred", [])[:2])
    color_ratio = blueprint.get("color_ratio") or "70% calm background, 20% structured hero subject, 10% accent highlights"
    lighting = blueprint.get("lighting") or material.get("lighting_depth") or "soft directional key light with gentle depth shadows"
    materials = blueprint.get("materials") or ", ".join(material.get("textures_materials", [])[:4]) or "frosted glass, matte surfaces, subtle luminous edges"
    text_area = blueprint.get("text_overlay_strategy") or "keep any final typography editable and aligned to the overall composition"
    hero_subject = blueprint.get("hero_subject") or request.get("message_to_communicate") or user_request or "brand-compliant hero visual"
    metaphor = blueprint.get("central_metaphor") or "a clear visual metaphor for the user's requested message"
    observations = material.get("image_specific_observations") or []
    observation_summary = " | ".join(
        str(item.get("screen_content") or item.get("image_content") or item.get("composition") or "")
        for item in observations[:2]
        if isinstance(item, dict)
    )
    transfer_rules = list(material.get("transferable_rules") or [])
    do_not_copy = list(material.get("do_not_copy_rules") or [])
    for item in observations:
        if isinstance(item, dict):
            transfer_rules.extend(item.get("transferable_rules") or [])
            do_not_copy.extend(item.get("do_not_copy") or [])
    transfer_rules = list(dict.fromkeys(str(x) for x in transfer_rules if x))[:6]
    do_not_copy = list(dict.fromkeys(str(x) for x in do_not_copy if x))[:6]
    fixed_asset_note = (
        "Overlay plan: Do not generate the logo or mascot; plan exact fixed asset overlays as intentional layout placements. "
        "Do not redraw, approximate, or stylize the logo or mascot inside the image; "
        "place exact fixed assets after background generation without turning the composition into a placeholder layout."
    )
    if any(word in hero_subject.lower() for word in ["logo", "mascot"]):
        hero_subject = "an abstract brand-safe hero scene that supports the fixed asset overlay"
    prompt = (
        f"Create a {platform} brand image for {brand_name} that directly communicates: {user_request}. "
        f"Core concept: {metaphor}. Hero subject: {hero_subject}. "
        f"Visual evidence: {observation_summary or material.get('overall_style') or 'use uploaded materials as source-level design evidence beyond color'}. "
        f"Transfer rules: {'; '.join(transfer_rules) or 'carry over composition rhythm, visual element language, typography hierarchy, material treatment, and lighting from the source evidence'}. "
        f"Composition: {composition or 'balanced rule-of-thirds layout with a single dominant focal point and integrated hierarchy'}; "
        f"keep information density {density}, and {text_area}. "
        f"Color system: use brand palette {', '.join(palette[:5]) or '#F2F0F1, #DDD7E2, #E8C7D0'} with proportions: {color_ratio}. "
        f"Lighting: {lighting}. Materials: {materials}. "
        f"{fixed_asset_note} "
        "Generate the background and non-branded hero subject first; final typography, logo, and mascot must be added as separate overlay assets. "
        f"Avoid {', '.join(do_not_copy) or 'copying the exact uploaded reference layout while preserving its transferable visual language'}."
    )

    return {
        "visual": {
            "visual_id": f"visual_{int(time.time())}",
            "platform": platform,
            "user_request": user_request,
            "prompt": prompt,
            "negative_instructions": generation.get("negative_prompt") or ["no neon", "no generated logo", "no distorted mascot", "no high saturation", "no dense small text", "no copied reference layout"],
            "compliance_explanation": f"Follows {brand_name} visual manual: user request, brand palette, asset overlay policy, composition rules, and {density} density.",
            "quality_checklist": [
                "The image communicates the user's requested topic without needing explanation.",
                "Brand palette and color proportions are visible and controlled.",
                "Logo, mascot, and final text are not baked into the generated background.",
                "Final typography can be added as an editable layer while preserving the integrated composition.",
            ],
            "preview": {
                "headline": user_request[:80] if user_request else "Brand-compliant visual",
                "palette": palette[:5],
                "layout": composition or "Balanced hero visual with fixed asset overlay",
            },
        }
    }


def _save_reference(args: dict) -> dict:
    brand_id = str(args.get("brand_id") or "").strip()
    visual = args.get("visual") or {}
    return {
        "reference": {
            "reference_id": f"ref_{int(time.time())}",
            "brand_id": brand_id or "brand_demo",
            "source_visual_id": visual.get("visual_id", "visual_demo"),
            "title": visual.get("preview", {}).get("headline", "Brand visual"),
            "usage": visual.get("platform", "demo"),
            "saved_at": int(time.time()),
            "notes": "Saved as Brand Reference.",
        }
    }


def _reverse_rpc(method: str, params: dict, timeout: float = 120.0) -> dict:
    """Send a v2 reverse-RPC request to the Anna host and wait for its response."""
    request_id = f"anna-visual-{method.replace('/', '-')}-{int(time.time() * 1000)}"
    send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        remaining = max(0.05, min(0.5, deadline - time.monotonic()))
        ready, _, _ = select.select([sys.stdin], [], [], remaining)
        if not ready:
            continue
        raw = sys.stdin.readline()
        if not raw:
            break
        try:
            msg = json.loads(raw.strip())
        except json.JSONDecodeError:
            continue
        if msg.get("id") == request_id:
            if msg.get("error"):
                error = msg["error"]
                return {"ok": False, "error": error, "status": "image_unavailable"}
            return {"ok": True, "result": msg.get("result") or {}}
        # Keep basic v1 requests responsive if they arrive while a reverse call is in flight.
        nested_method = msg.get("method")
        nested_id = msg.get("id")
        if nested_method == "health":
            send({"jsonrpc": "2.0", "id": nested_id, "result": handle_health(msg.get("params") or {})})
        elif nested_method == "describe":
            send({"jsonrpc": "2.0", "id": nested_id, "result": handle_describe(msg.get("params") or {})})
    return {
        "ok": False,
        "status": "image_unavailable",
        "error": {"code": "IMAGE_TIMEOUT", "message": f"{method} reverse RPC timed out"},
    }


def _generate_image(args: dict) -> dict:
    prompt = str(args.get("prompt") or (args.get("package") or {}).get("final_prompt_object", {}).get("prompt") or "").strip()
    if not prompt:
        return {"status": "image_unavailable", "error": {"code": "IMAGE_INVALID_REQUEST", "message": "Missing image prompt."}}
    if not PROTOCOL_V2_NEGOTIATED:
        return {
            "status": "image_unavailable",
            "error": {
                "code": "IMAGE_NOT_NEGOTIATED",
                "message": "Executa protocol v2 image bridge was not negotiated in this runtime.",
            },
            "fallback_prompt": prompt,
        }
    params = {
        "prompt": prompt,
        "n": int(args.get("n") or 1),
        "size": str(args.get("size") or "1024x1024"),
        "reference_image_urls": (args.get("reference_image_urls") or [])[:3],
        "reference_images": (args.get("reference_images") or [])[:3],
        "modelPreferences": args.get("modelPreferences") or {"hints": []},
        "metadata": args.get("metadata") or {},
    }
    result = _reverse_rpc("image/generate", params, timeout=float(args.get("timeout_s") or 120.0))
    if not result.get("ok"):
        return {**result, "payload": params, "fallback_prompt": prompt}
    return {"status": "generated", "image_result": result["result"], "payload": params}


def _edit_image(args: dict) -> dict:
    image_url = str(args.get("image_url") or "").strip()
    prompt = str(args.get("prompt") or "").strip()
    if not image_url or not prompt:
        return {"status": "image_unavailable", "error": {"code": "IMAGE_INVALID_REQUEST", "message": "Missing image_url or edit prompt."}}
    if not PROTOCOL_V2_NEGOTIATED:
        return {
            "status": "image_unavailable",
            "error": {
                "code": "IMAGE_NOT_NEGOTIATED",
                "message": "Executa protocol v2 image edit bridge was not negotiated in this runtime.",
            },
            "fallback_prompt": prompt,
        }
    params = {
        "image_url": image_url,
        "prompt": prompt,
        "n": int(args.get("n") or 1),
        "mask_url": args.get("mask_url") or None,
        "metadata": args.get("metadata") or {},
    }
    result = _reverse_rpc("image/edit", params, timeout=float(args.get("timeout_s") or 120.0))
    if not result.get("ok"):
        return {**result, "payload": params, "fallback_prompt": prompt}
    return {"status": "generated", "image_result": result["result"], "payload": params}


# ── JSON-RPC over stdio (v1) ──

def send(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_describe(_params: dict) -> dict:
    return MANIFEST


def handle_health(_params: dict) -> dict:
    return {"status": "ok"}


def handle_initialize(_params: dict) -> dict:
    global PROTOCOL_V2_NEGOTIATED
    PROTOCOL_V2_NEGOTIATED = True
    return {
        "protocolVersion": "2.0",
        "serverInfo": {"name": TOOL_ID, "version": MANIFEST["version"]},
        "capabilities": {
            "image": {"generate": True, "edit": True},
            "upload": {},
        },
        "client_capabilities": {
            "image": {"generate": True, "edit": True},
            "upload": {},
        },
    }


def handle_invoke(params: dict) -> dict:
    tool = params.get("tool")
    args = params.get("arguments") or {}
    try:
        if tool == "analyze_brand_material":
            data = _analyze_brand_material(args)
        elif tool == "generate_brand":
            data = _generate_brand(args)
        elif tool == "create_visual":
            data = _create_visual(args)
        elif tool == "save_reference":
            data = _save_reference(args)
        elif tool == "generate_image":
            data = _generate_image(args)
        elif tool == "edit_image":
            data = _edit_image(args)
        else:
            return {"success": False, "error": f"Unknown tool: {tool!r}"}
        return {"success": True, "tool": tool, "data": data}
    except Exception as e:
        return {"success": False, "error": f"{type(e).__name__}: {e}"}


def main() -> None:
    print("[brand-mvp] AnnaVisual Brand MVP ready (v1/v2 stdio, image bridge capable)", file=sys.stderr)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            continue
        method = req.get("method")
        req_id = req.get("id")
        params = req.get("params") or {}
        if method == "describe":
            result = handle_describe(params)
        elif method == "initialize":
            result = handle_initialize(params)
        elif method == "invoke":
            result = handle_invoke(params)
        elif method == "health":
            result = handle_health(params)
        else:
            send({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"unknown method: {method}"}})
            continue
        send({"jsonrpc": "2.0", "id": req_id, "result": result})


if __name__ == "__main__":
    main()

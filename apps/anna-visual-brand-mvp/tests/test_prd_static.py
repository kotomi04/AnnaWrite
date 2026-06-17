#!/usr/bin/env python3
"""Static acceptance checks for the Brand + Designer MVP UI flow."""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = (ROOT / "bundle" / "app.js").read_text(encoding="utf-8")
HTML = (ROOT / "bundle" / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "bundle" / "style.css").read_text(encoding="utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    require('id="imageNav"' in HTML and 'id="brandNav"' in HTML and 'id="designerNav"' in HTML, "missing Image / Brand / Designer navigation")
    require("BRAND_STORAGE_KEY" in APP and "DESIGNER_STORAGE_KEY" in APP and "GENERATION_STORAGE_KEY" in APP, "missing separated storage keys")
    require("annaStorageGet" in APP and "localStorage.setItem" in APP, "missing Anna storage with local fallback")
    require("renderBrandStudio" in APP and "Analyze & save Brand" in APP and "Confirm Brand" in APP, "missing Brand creation/save flow")
    require("renderDesignerStudio" in APP and "Generate from Brand" in APP and "saveDesignerFromForm" in APP, "missing Designer creation/save flow")
    require("designer_brand_match" in APP and "The selected Designer does not belong to this Brand" in APP, "missing Designer-to-Brand guard")
    require("buildGenerationContext" in APP and "buildFinalPrompt" in APP and "buildPackage" in APP, "missing generation package pipeline")
    require("brand_profile" in APP and "logo_rule_detail" in APP and "visual_evidence_digest" in APP, "missing PRD-aligned Brand fields")
    require("Logo hard constraints:" in APP and "no recolored logo" in APP and "no stretched logo" in APP and "no rotated logo" in APP, "missing logo hard constraints")
    require("extractImageEvidence" in APP and "density_grid_3x3" in APP and "visual_focus_region" in APP, "missing deeper image evidence extraction")
    require("main_visual_elements" in APP and "typography_layout" in APP and "materials_lighting" in APP, "missing visual style extraction fields")
    require("imageDraftInput" in APP and "analyzeGenerationDrafts" in APP and "uploaded_design_draft_evidence" in APP, "missing image-generation draft upload and analysis")
    require("VISUAL_CHOICE_GROUPS" in APP and "renderVisualRefine" in APP and "Shape the image" in APP, "missing visual-choice replacement for text Q&A")
    require("Layout structure" in APP and "Image language" in APP and "Surface finish" in APP, "missing image-first choice groups")
    require("currentVisualPalette" in APP and "thumbPalette" in APP and "focusPoint" in APP, "visual choices should use extracted palette and source focus")
    require("thumbKind" in APP and "thumbLayers" in APP and "source_thumb_data_url" in APP, "thumbnails should be semantic and reference-aware")
    require("refreshDesignReading" in APP and "AI Design Reading" in APP and "llm_design_reading" in APP, "missing LLM design reading phase")
    require("capabilities" in APP and "renderCapabilityPanel" in APP and "Live Generate Mode" in APP and "Anna Chat Package Mode" in APP, "missing runtime capability diagnostics and separated generation modes")
    require("LLM reading" in APP and "Image generation" in APP and "Image edit" in APP and "Executa bridge" in APP, "capability panel should explain runtime grants")
    require("readingMode" in APP and "Fast Mode" in APP and "Strict LLM Mode" in APP and "renderReadingModePanel" in APP, "missing Fast/Strict LLM reading mode switch")
    require("applyFallbackDesignReading" in APP and "prepareDesignReading" in APP and "ready_local" in APP, "design reading should have LLM-first flow with local fallback")
    require("strict_failed" in APP and "Strict LLM Mode did not receive a complete LLM reading" in APP, "Strict mode should block if LLM reading is incomplete")
    require('prepareDesignReading("start design", { strict: true })' in APP and 'prepareDesignReading("generate prompt package", { strict: true })' in APP, "Strict mode should prioritize complete LLM design reading before visual decisions")
    require('ensureDesignReading("start design")' in APP and 'ensureDesignReading("generate prompt package")' in APP, "Fast mode should use local reading first and continue without blocking")
    require("maybeImprovePrompt" in APP and "Building the final image package" in APP, "prompt package should refine while showing a stable loading state")
    require("function listify" in APP and "listify(material.transferable_rules)" in APP, "LLM string/list fields should be normalized before rendering")
    require('"ready"' in APP and '"enhancing"' in APP and "optional LLM refinement is running" in APP, "background enhancement should not appear as a blocking state")
    require("buildPromptQualityReport" in APP and "promptPassesQualityGate" in APP and "llm_refinement_rejected" in APP, "LLM-refined prompts should pass quality gate before replacement")
    require("brand_palette" in APP and "logo_asset_policy" in APP and "source_design_reading" in APP, "prompt quality gate should protect brand, logo, and source evidence")
    require("source_image_audit" in APP and "generation_strategy" in APP and "validateDesignerAgainstBrand" in APP, "missing separated source audit, generation strategy, and Designer guard")
    require("cannot_change_logo_rules" in APP and "cannot_make_banned_colors_primary" in APP and "cannot_generate_logo_or_mascot" in APP, "Designer should carry Brand hard-constraint guards")
    require("visual_choice_guidance" in APP and "prompt_package_visual_plan" in APP, "missing LLM-guided choices and package plan")
    require("data-direction-edit" in APP and "renderDirectionEditor" in APP and "Edit selected template" in APP, "missing selectable/editable direction templates")
    require("source_reference_inputs" in APP and "attachment_manifest" in APP and "abstract_style_draft" in APP, "missing multimodal generation handoff package")
    require("generateImageFromPackage" in APP and "directHostImageGenerate" in APP and "executaImageGenerate" in APP, "missing direct image generation flow")
    require("Structure sketch" in APP and "not a generated result" in APP and "Check live grant" in APP, "fallback previews should not pretend to be generated images")
    require("generatePreviewImage" in APP and "generateDirectionPreviewSet" in APP and "generatedPreviews" in APP, "visual choices and directions should request generated preview images")
    require("renderLoadingStep" in APP and "goToDirection" in APP and "withTimeout" in APP, "image generation should use stable loading screens and short timeouts")
    require("aiCompleteWithImages" in APP and "analysis_image_data_url" in APP and "reference_images" in APP, "LLM reading and image generation should pass uploaded design imagery when possible")
    require("editGeneratedImage" in APP and "imageGenerationStatus" in APP and "generated-preview" in CSS, "missing generated image preview/edit loop")
    require("Image generation is not granted" in APP and "IMAGE_NOT_NEGOTIATED" in APP, "missing image grant / negotiation fallback messaging")
    require("PPT_MASTER_RULES" in APP and "direct front-facing full-frame 16:9 slide canvas" in APP, "missing PPT prompt discipline")
    require("AUTO_PLATFORM" in APP and "platform: AUTO_PLATFORM" in APP, "platform should default to Auto")
    require("context-chip" in CSS and "direction-grid" in CSS and "package-grid" in CSS and "visual-choice-grid" in CSS and "studio-layout" in CSS, "missing redesigned studio UI styles")
    require("choice-card.selected::after" in CSS and "direction.selected::after" in CSS and "thumbPalette" in APP, "missing strong selected states for visual choices or directions")
    require("semantic-thumb" in CSS and "thumb-kind-reference" in CSS and "thumb-kind-platform" in CSS, "missing semantic thumbnail styles")
    require("ai-reading" in CSS and "motif-layer" in CSS and "thumb-caption" in CSS, "missing LLM reading and request-motif UI styles")
    require("chatMessages" not in HTML and "chatInput" not in HTML, "UI should no longer be chat-first")
    print("  ✓ Brand + Designer static checks passed")


if __name__ == "__main__":
    main()

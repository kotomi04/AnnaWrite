#!/usr/bin/env python3
"""Test the brand-mvp Executa plugin contract — v2 with sampling support.

Uses subprocess with stdin piping; the plugin runs its main loop
and responds line-by-line.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "executas" / "brand-mvp" / "brand_mvp_plugin.py"


class PluginProcess:
    """Persistent plugin subprocess for testing."""
    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, str(PLUGIN)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        # Drain stderr
        import threading
        self._stderr = []
        def _drain():
            for line in self.proc.stderr:
                self._stderr.append(line)
        t = threading.Thread(target=_drain, daemon=True)
        t.start()

    def rpc(self, method: str, params: dict | None = None, req_id: int = 1) -> dict:
        request = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            request["params"] = params
        self.proc.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        # Read until we get a JSON response with matching id
        for _ in range(200):  # timeout after 200 reads
            raw = self.proc.stdout.readline()
            if not raw:
                raise RuntimeError("Plugin process exited unexpectedly")
            try:
                msg = json.loads(raw.strip())
                if msg.get("id") == req_id:
                    return msg
                # Could be a reverse RPC (sampling request) — ignore in test
            except json.JSONDecodeError:
                continue
        raise TimeoutError("No response from plugin")

    def close(self):
        self.proc.stdin.close()
        self.proc.terminate()
        self.proc.wait(timeout=5)


def main() -> None:
    p = PluginProcess()
    try:
        # ── describe ──
        described = p.rpc("describe")
        manifest = described["result"]
        assert manifest["display_name"] == "AnnaVisual Brand MVP"
        assert "llm.image" in manifest.get("host_capabilities", [])
        tool_names = {tool["name"] for tool in manifest["tools"]}
        assert tool_names == {
            "analyze_brand_material",
            "generate_brand",
            "create_visual",
            "save_reference",
            "generate_image",
            "edit_image",
        }, f"Expected 6 tools, got: {tool_names}"
        print("  ✓ describe: all 6 tools registered")

        initialized = p.rpc("initialize", {}, req_id=11)
        assert initialized["result"]["protocolVersion"] == "2.0"
        assert initialized["result"]["capabilities"]["image"]["generate"] is True
        print("  ✓ initialize: v2 image bridge capability declared")

        # ── analyze_brand_material ──
        analyzed = p.rpc(
            "invoke",
            {
                "tool": "analyze_brand_material",
                "arguments": {
                    "source_files": [
                        {"file_id": "file_001", "file_name": "brand-guide.pdf", "file_type": "pdf"},
                    ],
                    "brand_hint": "Anna",
                    "user_request": "LinkedIn poster about secure AI",
                    "platform": "LinkedIn",
                    "style_description": "Premium muted pastel tech brand",
                    "reference_intake": {"asset_identity": "Premium AI brand"},
                },
            },
        )
        assert analyzed["result"]["success"] is True
        data = analyzed["result"]["data"]
        vm = data.get("visual_manual") or {}
        assert vm.get("metadata", {}).get("project_name") == "Anna"
        assert "color_system" in vm
        assert "material_analysis" in vm
        assert "image_specific_observations" in vm["material_analysis"]
        print("  ✓ analyze_brand_material: returns visual_manual")

        # ── generate_brand ──
        generated = p.rpc(
            "invoke",
            {
                "tool": "generate_brand",
                "arguments": {
                    "brand_hint": "Anna",
                    "user_request": "LinkedIn poster about AI",
                    "platform": "LinkedIn",
                    "analyzed_context": data,
                },
            },
        )
        assert generated["result"]["success"] is True
        result_vm = generated["result"]["data"]["visual_manual"]
        assert result_vm["metadata"]["project_name"] == "Anna"
        print("  ✓ generate_brand: produces visual_manual")

        # ── create_visual ──
        visual = p.rpc(
            "invoke",
            {
                "tool": "create_visual",
                "arguments": {
                    "visual_manual": result_vm,
                    "user_request": "Make a LinkedIn poster about secure AI Agents",
                    "platform": "LinkedIn",
                },
            },
        )
        assert visual["result"]["success"] is True
        vis_data = visual["result"]["data"]
        v = vis_data.get("visual") or {}
        assert v.get("prompt") or v.get("compliance_explanation")
        assert "Visual evidence:" in v.get("prompt", "")
        assert "Transfer rules:" in v.get("prompt", "")
        print("  ✓ create_visual: generates prompt")

        # ── save_reference ──
        saved = p.rpc(
            "invoke",
            {
                "tool": "save_reference",
                "arguments": {
                    "brand_id": "Anna",
                    "visual": v,
                },
            },
        )
        assert saved["result"]["success"] is True
        assert saved["result"]["data"]["reference"]["brand_id"] == "Anna"
        print("  ✓ save_reference: saves successfully")

        # Image tool request should fail gracefully in the test harness because
        # there is no host reverse-RPC responder, while preserving fallback prompt.
        image_result = p.rpc(
            "invoke",
            {
                "tool": "generate_image",
                "arguments": {
                    "prompt": "Generate a clean AnnaVisual test image.",
                    "size": "1024x1024",
                    "n": 1,
                    "timeout_s": 0.05,
                },
            },
            req_id=12,
        )
        assert image_result["result"]["success"] is True
        assert image_result["result"]["data"]["status"] in {"image_unavailable", "generated"}
        print("  ✓ generate_image: structured image bridge response")

        print("\n  All tests passed.")

    finally:
        p.close()


if __name__ == "__main__":
    main()

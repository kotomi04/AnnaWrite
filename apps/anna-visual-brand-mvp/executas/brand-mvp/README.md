# AnnaVisual Brand MVP Executa

Deterministic local tool for demoing the AnnaVisual Brand MVP loop:

1. `generate_brand` returns an editable Brand Profile from sample Anna visual references.
2. `create_visual` combines the active Brand Profile with a user request and returns a visual-generation instruction, compliance explanation, and preview metadata.
3. `generate_image` / `edit_image` call the Anna host image bridge when Executa protocol v2 is negotiated.
4. `save_reference` returns a reference object that can be shown in Brand Detail.

If the runtime has not negotiated the v2 image bridge or the user has not granted image generation, the image tools return a structured `image_unavailable` response and the app falls back to the prompt/JSON package. Logo and mascot remain fixed overlay assets.

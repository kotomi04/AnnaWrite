# AnnaVisual Brand MVP

This is a runnable MVP demo for `https://staging.anna.partners/developer`.

The demo validates the smallest loop:

1. Upload / select brand source files.
2. Generate an editable Brand Profile.
3. Confirm the Brand as Active.
4. Create a brand-constrained visual brief.
5. Save the result as a Brand Reference.

The most important product rule is included: logo and mascot are fixed brand assets. They should be overlaid or generated in a separate confirmed variant workflow, not freely drawn inside a general image prompt.

## Local check

```bash
npm install
npm run test:tool
npm run dev
```

## Staging Developer flow

1. Open `https://staging.anna.partners/developer` while logged in.
2. Create a new Anna App named `AnnaVisual Brand MVP`.
3. Use `app.json` for marketplace/app metadata.
4. Use `manifest.json` for app permissions and required Executa.
5. Upload or register the static bundle under `bundle/`.
6. Register the Executa tool from `executas/brand-mvp/brand_mvp_plugin.py`.
7. Test the happy path:
   - Generate Brand.
   - Confirm Brand.
   - Create Visual.
   - Save as Brand Reference.

## Demo talk track

This demo does not claim to solve full brand asset management. It proves that Anna can turn brand material into structured rules and then use those rules as hard constraints during generation.

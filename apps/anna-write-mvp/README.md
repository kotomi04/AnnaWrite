# AnnaWrite MVP

AnnaWrite is a lightweight Anna writing workspace with reusable author styles, Anna LLM draft generation, sentence-level revision, a document-like editor, and local export for Markdown, TXT, HTML, DOCX, and PDF.

## Run locally

```bash
npm install
npm run dev -- --port 5180
```

Open `http://localhost:5180/`.

## Anna app bundle

Build and validate the Anna app:

```bash
npm run validate:anna
```

Generated upload files are kept in `release/`:

- `release/anna-write-ui-bundle.zip`
- `release/anna-write-mvp-staging.zip`

## Notes

- Anna LLM calls are routed through `src/services/llmService.ts`.
- Prompt builders live in `src/services/promptBuilders.ts`.
- Drafts, projects, and author profiles are persisted with browser `localStorage`.

# Fixtures

Representative, **sanitized** API responses used by unit tests. They contain no
real OCR text, tokens, hostnames, or personal data:

- Paperless hostnames are replaced with `paperless.invalid`.
- OCR `content` is replaced with `[OCR text removed from fixture]`.
- Vocabulary names are fictional (`Example Tag`, `Example Correspondent`,
  `Example Type`).
- Document ids and titles are synthetic.

Files:

- `paperless/status.json` — `/api/status/` shape.
- `paperless/tags-page-1.json` — paginated tags with a non-null `next`.
- `paperless/tags-page-2.json` — final page with `next: null`.
- `paperless/correspondents-page.json` — paginated correspondents.
- `paperless/document-types-page.json` — paginated document types.
- `paperless/documents-pending.json` — projected document list.
- `paperless/document-detail.json` — document detail with staged OCR.
- `llm/proposal-valid.json` — valid chat completion.
- `llm/proposal-invalid.json` — invalid proposal fields.

The exact build and behavior these represent are recorded in
`docs/api-notes.md`.

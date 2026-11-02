<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# OpenMAIC Integration Modules

This section is durable project context. Keep Module 1 and Module 2 boundaries
distinct when changing integration code.

## Module 1: external platform integration

The external platform owns the teacher-facing prompt and outline-review UI.
OpenMAIC owns source extraction, outline generation, and the full course
generation pipeline.

1. The platform sends the prompt and source materials to
   `POST /api/integration/v1/outlines`.
2. The request can be multipart with the original files or JSON with stored
   `materialIds`. OpenMAIC extracts text, embedded images, and document layout;
   it does not require the platform to pre-convert files to plain text.
3. OpenMAIC stores the extracted sources under tenant-bound `materialIds` and
   returns `outlines`, `courseTitle`, `languageDirective`, material summaries,
   and warnings.
4. The teacher reviews or edits the outline on the external platform.
5. The platform sends the approved outline, source prompt, and `materialIds` to
   `POST /api/integration/v1/courses` with a required `Idempotency-Key`.
6. OpenMAIC rehydrates the stored material context, queues the existing course
   pipeline, and uses the approved outline without regenerating it.
7. The platform polls
   `GET /api/integration/v1/courses/jobs/{jobId}` and redirects to the returned
   OpenMAIC classroom URL when generation succeeds.

Key files:

- `app/api/integration/v1/outlines/route.ts`
- `app/api/integration/v1/courses/route.ts`
- `lib/server/integration/material-context.ts`
- `lib/server/integration/contract.ts`

Module 1 invariants:

- Preserve original-file upload support; JSON text materials remain a legacy
  compatibility path.
- Approved `outlines`, `courseTitle`, and `languageDirective` must survive the
  handoff unchanged except for validated ordering and required normalization.
- Repeated requests with the same tenant and `Idempotency-Key` must reuse the
  original job and must not start or reload a second generation.
- Material IDs are tenant-scoped. Never resolve another tenant's material.

## Module 2: OpenMAIC handoff flow

The external platform uploads the source materials and freezes the prompt, but
the browser enters OpenMAIC for the handoff landing, outline/generation preview,
and final classroom. The current mode is `single-game`.

1. The platform uploads original files to
   `POST /api/integration/v1/materials`. OpenMAIC extracts and stores text,
   embedded images, and layout-page rasters, then returns opaque material IDs.
2. The platform calls `POST /api/integration/v1/handoffs` with `tenantId`,
   `prompt`, `materialIds`, and optional return/trace metadata. The response
   contains a `/game?handoff=<id>` redirect URL and a two-hour handoff expiry.
3. `/game?handoff=<id>` renders the handoff landing. The browser reads the
   handoff payload and previews the stored source material.
4. Starting generation builds the normal single-game session from extracted
   text, image mappings, and layout context, then navigates to
   `/generation-preview`.
5. A handoff session skips the normal outline-review pause and automatic agent
   role generation, then runs through OpenMAIC's existing generation pipeline.
6. After the classroom is saved, the browser calls
   `POST /api/integration/v1/handoffs/{id}/result` with the per-handoff
   completion token and generated stage ID.
7. The platform polls `GET /api/integration/v1/handoffs/{id}` over the
   server-to-server API and receives the canonical classroom `resourceUrl`
   after the status becomes `succeeded`.

Key files:

- `app/api/integration/v1/materials/route.ts`
- `app/api/integration/v1/handoffs/route.ts`
- `components/integration/HandoffLanding.tsx`
- `lib/integration/handoff-session.ts`
- `lib/integration/handoff-client.ts`
- `app/generation-preview/page.tsx`

Module 2 invariants:

- Source files are normalized by OpenMAIC extraction; preserve text, image, and
  layout information instead of reducing uploads to filename-only metadata.
- The browser-facing payload endpoint is authorized by the opaque handoff ID.
  The HMAC integration secret must never be sent to the browser.
- Only the per-handoff completion token can mark a handoff complete.
- A failed result report must not discard an already generated classroom.
- Keep handoff generation on the existing OpenMAIC pipeline instead of creating
  a parallel generator.

## Download And Deployment Location

- Perform downloads, dependency installs, generated build artifacts, package
  caches controlled by this project, and deployments on the E: drive only.
- Do not intentionally download, install, cache, or deploy project content on
  the C: drive. If a tool defaults to a C: drive location, override it to an
  appropriate location under `E:\OpenMAIC-dev` or another E: drive path.

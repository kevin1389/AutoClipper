# AutoClipper

Browser-native AI video clipping. Upload a recording (or attach the file for a YouTube link you are authorized to use). The project starts processing automatically: it transcribes the source, finds complete, distinct moments with a quality-gated selector (target 8, hard maximum 10) and renders **real** 1080×1920 MP4 clips with burned-in word captions. There is no filler target: a weak or repetitive recording can yield fewer than five clips, including none.

There is no per-video two-clip cap, no daily clip quota, no credit system and no paid transcription API. Each upload is scored independently; a full-length recording with enough distinct strong moments is not throttled. A short recording gets one clearly labelled best-available clip; a long weak or repetitive one may get fewer, including zero, rather than fake moments to reach 8 or 10.

There is no Python service, native FFmpeg worker, paid transcription API, or separate processing server in the normal path. Media work runs in a Web Worker in the user’s browser:

- **FFmpeg.wasm** (`@ffmpeg/core`) for probing, audio extraction, scene changes, 9:16 cuts, captions, zooms, slow motion and MP4 encoding.
- **Transformers.js** with quantized `Xenova/whisper-tiny.en` for real word timestamps. WebGPU is preferred; the verified fallback is WASM CPU inference.
- The browser keeps the original video in IndexedDB and mounts it read-only into FFmpeg.wasm through WORKERFS. In the normal path the source is never copied into the JS heap or uploaded to remote object storage; only finished MP4s, posters and project metadata reach the server. The browser never receives storage credentials.

A resumable 8 MB-part multipart API remains available for operators that explicitly want a server-side source copy. It writes to the configured S3 pool, or to legacy R2 when no pool is configured. The dashboard does not use it, because a 1 GB original would consume a large share of the 18 GB safety pool.

The app server is still required for the UI, email/password accounts, D1 metadata, object storage (the S3 pool or legacy R2) and authenticated streaming. It does not process video.

## Stack

| Layer | Choice |
| --- | --- |
| App | Next.js 16 App Router, React 19, Tailwind CSS 4 |
| Browser media | `@ffmpeg/core` ESM in a module Web Worker |
| Browser transcription | `@huggingface/transformers` + `Xenova/whisper-tiny.en` (WebGPU/WASM) |
| Database | Cloudflare D1 in production; Node `node:sqlite` locally |
| Objects | S3-compatible free-tier pool (B2 → Tigris → Filebase) when configured; legacy Cloudflare R2 (`FILES`) and local filesystem remain supported |
| Accounts | Email/password (scrypt), sessions, verification/reset, optional Google |
| Deployment | Cloudflare Workers/Sites-compatible Next.js output |

### Multi-provider object storage

The object layer is provider-neutral. When at least one S3-compatible provider is configured, new objects use a server-side pool; existing `r2://` objects and local projects remain readable through the same storage API. New paths use `s3://<provider>/<key>`, and the `storage_objects` ledger in D1 records each object's provider, bucket, key, size, status and project.

| Provider | Role | Nominal free tier | App safety cap |
| --- | --- | ---: | ---: |
| Backblaze B2 | Hot; first choice | 10 GB | 9 GB |
| Tigris | Overflow | 5 GB | 4.5 GB |
| Filebase | Cold; last choice | 5 GB | 4.5 GB |
| **Total** | | **20 GB** | **18 GB** |

Sizes are decimal GB. Each cap leaves a reserve below the advertised free tier. Nominal limits are not assumed: the dashboard only reports a provider as verified after a successful bucket check and listing. If the first provider is unavailable or the object would exceed its cap, the allocator tries the next eligible provider. If none can accept it, the upload fails visibly; there is no paid fallback and no silent switch to a different service.

Capacity is reserved with one atomic SQL statement in D1/SQLite, not an in-process mutex. That statement checks the provider cap and aggregate target together, counts complete objects, active upload/multipart reservations and the last measured non-AutoClipper bucket bytes, and inserts the reservation only if both checks pass. Separate Workers therefore cannot both reserve the same free bytes. Reservations expire (24 hours by default); cleanup aborts the abandoned multipart session or verifies removal of an ambiguous PUT before releasing capacity. Pending uploads count against the same caps as completed objects.

SigV4 requests have a deterministic signing path tested against AWS’s published GET-object vector, virtual-hosted and path-style URLs, signed headers and explicit payload hashes. Buffered bodies (multipart parts and XML) use their real SHA-256; a streaming PUT uses `UNSIGNED-PAYLOAD` over TLS and is HEAD-verified after completion. The local mock rejects wrong secrets, tampered payloads and stale timestamps. None of this proves a real provider account works: run the smoke check below after adding credentials.

### Configure and verify credentials

1. Create each free account and bucket yourself. AutoClipper does not sign up, add payment details or upgrade a plan.
2. Put the server-only values in an untracked `.env` for local use, or in the deployment’s encrypted secret store. The required names are `AC_B2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_BUCKET`, and equivalently for `AC_TIGRIS` and `AC_FILEBASE`. Set `_ENDPOINT` and `_REGION` when the defaults do not match the bucket. Never use `NEXT_PUBLIC_*` names, commit `.env`, or paste a secret into a client bundle.
3. With the credentials loaded in the shell, run `npm run storage:smoke` (or `node --env-file=.env --import tsx scripts/storage-smoke.ts`). This is an explicit operator action: it uploads one tiny uniquely named text object per configured provider, signs and verifies HEAD/GET/LIST, deletes it and checks that it is gone. It does not run at application startup.
4. Only after those checks does the dashboard mark all three providers verified and expose the full application target as available. Without a real pass, the target remains **configured but unverified**.

Configure providers independently with the server-only `AC_B2_*`, `AC_TIGRIS_*` and `AC_FILEBASE_*` settings documented in `.env.example`. Each provider needs `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_BUCKET` and, when the default does not fit, `_ENDPOINT` and `_REGION`. Keep them in `.env` locally (never committed) or in the hosting provider’s encrypted server-secret store; never use `NEXT_PUBLIC_*`. AutoClipper never creates accounts, activates free tiers, adds payment methods or upgrades plans. Buckets should be dedicated to AutoClipper. The 18 GB target is **configured, not verified**, until all three providers authenticate and list successfully.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

`npm run dev` and `npm run build` run `prepare:browser`, which copies the FFmpeg core, ONNX Runtime WASM and the caption font into `public/`. The pinned Whisper Tiny assets are served from `public/models/Xenova/whisper-tiny.en/`; the app never downloads them from Hugging Face at runtime. The first transcription downloads the 44.5 MB WASM set (or the larger WebGPU set) from the app origin into versioned Cache Storage and reuses completed files. The project UI shows byte progress, and a failed download offers **Retry model download** without requiring another video upload.

No `.env` is required for local use. There is no `setup:whisper`, no `npm run worker`, and no system FFmpeg/Python dependency.

## Processing pipeline

1. Create a project and save the selected `File` into the browser’s IndexedDB. The extension and the **1 GiB** ceiling are validated before the project is created. No source bytes are uploaded on the normal path; D1 stores a `local://<projectId>` marker instead of a source object key.
2. The project opens and starts processing automatically. A dedicated Web Worker:
   - mounts the local `File` read-only with FFmpeg.wasm’s `WORKERFS`, probes duration, dimensions, frame rate and audio, then unmounts it when the run ends. The file is never copied into MEMFS or into one large JS buffer;
   - extracts audio in 5-minute sections with a 2-second overlap, deletes each WAV from FFmpeg’s memory filesystem after decoding, and releases the section buffers before starting the next one;
   - transcribes each section with `return_timestamps: 'word'` (no synthetic timings), offsets every word by the section’s absolute source position, merges overlap duplicates, and saves the transcript. A retry reuses that transcript instead of re-running Whisper; re-running selection may still measure audio signals;
   - scores the real transcript with the explainable heuristic: complete-thought boundaries, content type (funny, surprising, dramatic, emotional, informative), hook, entertainment, substance, context, payoff, pacing and near-duplicate rejection; candidates below the quality floor are rejected, and the target is never padded;
   - saves the transcript, selection and progress to D1;
   - samples each selected clip for a lightweight RGB subject estimate, then renders it with FFmpeg.wasm: a smooth subject-aware 9:16 pan (or a stable center fallback), 1080×1920, H.264/AAC, ASS word captions, at most three evidence-backed camera moves and occasional evidence-backed slow motion. Each edit piece is input-seeked, so the eighth clip does not decode the first nineteen minutes again;
   - for sources longer than 10 minutes, detects scene changes inside each selected clip before planning, preserving slow motion’s visual signal without decoding the whole file;
   - uploads each MP4/poster and finalizes the clip only after the bytes exist.
3. Downloads stream through owner-scoped routes. ZIP export packages the already-rendered clips; it does not re-encode them.

### Selection, framing and captions

Selection starts at complete sentence boundaries and rejects unfinished thoughts. It scores content type, hook, context, payoff, pacing and entertainment, then keeps a candidate only when it clears a 34/100 absolute floor and 68% of the strongest candidate; near-duplicates are removed. The target is eight and the hard cap is ten, with no padding. A short source gets one explicit “best available” fallback; a long weak or repetitive source can return zero.

Each clip is sampled for a lightweight subject estimate from skin-tone and visual-detail evidence. A confident off-centre estimate gets a smooth start-to-end 9:16 pan; a weak one stays on a stable center crop. This is not face recognition, active-speaker detection or diarization. Camera moves are capped at three per clip, spaced apart and eased; zoom and slow motion are evidence-gated. Cuts land on sentence or pause boundaries. Captions use real word timings, 84px type, at most four words/20 characters and a 300px bottom margin. There are no random sound effects or crossfades — the build ships no SFX assets and uses clean jump cuts.

The tab must stay open while processing. Progress is persisted; closing the tab pauses work, and the project page offers **Resume in this browser**. The source and transcript are retained across a failed render, and a retry reuses the saved transcript so Whisper does not run again. If a model file is missing or a download is interrupted, the page shows the exact HTTP or network error and **Retry model download**; already-cached model files are reused on retry.

## Transcript and captions

`Xenova/whisper-tiny.en` is the Transformers.js reference model exported with cross-attentions, which is required for provider word timestamps. The `onnx-community` export was tried and correctly failed rather than fabricating timings. Captions are ASS files with per-word karaoke timing and the DejaVu Sans Bold font copied into `public/fonts`.

The verified browser run (WASM fallback) produced:

- 22 real words with word-level timing from the JFK speech sample;
- a 10.74 s, 1080×1920 H.264/AAC MP4 at 30 fps;
- visible word-synced captions at 1 s, 5 s and 9 s;
- a second edit (1–9 s, custom caption) rendered exactly 8.00 s at 1080×1920.

WebGPU was not available in the headless verification browser; the WebGPU branch is implemented but was not exercised there.

## Limits and failure behavior

- **Clip count: quality-gated, up to 10.** Selection targets eight strong moments and hard-caps at ten; it never pads to reach either number. Five to ten is typical only when the recording contains enough distinct strong moments. A short source gets one explicit best-available clip; a weak or repetitive long source can produce fewer, including none.
- **Source ceiling: 1 GiB (1,024 MB)**, enforced in the browser before the project is created, again by the project/source APIs and by the worker. The UI uses the same value.
- **Clip upload ceiling: 95 MB per asset**, because clips pass through the authenticated Worker route (no object-storage credentials are exposed to the browser).
- **Object-storage safety target: 18 GB** across the three free tiers. The allocator fills B2 first, then Tigris, then Filebase, and refuses an upload that would cross a provider cap or the aggregate target. Actual provider listings, active reservations and pending multipart bytes determine available room; failed measurements are shown as unavailable rather than zero. The dashboard does not present 18 GB as available unless all three providers are configured and verified. If no S3 provider is configured, the legacy R2 binding or local filesystem remains active; source videos stay on the device, so the pool is spent on clips, posters and project files rather than on a second copy of the original.
- **No paid storage fallback.** A full or unreachable free provider produces an error; AutoClipper does not switch to a paid service, upgrade a plan or add a payment method.
- **Local source retention:** the original lives in the origin’s IndexedDB. The dashboard waits for the IndexedDB transaction to **commit** before navigating, so a large file cannot be reported as saved and then disappear during the handoff. Clearing site data, using private browsing, or opening the project in another browser/device removes access. The project page then asks for the file again; completed clips remain available. Closing the tab pauses processing, and the source is retained for a retry.
- **Section retry and duplicate protection:** a failed 5-minute audio extraction or transcription section is retried once from the bounded section before the project fails. Clips are created and finalized by stable project/index/id, and finalization verifies the uploaded object before marking it rendered, so a retry cannot silently create a second copy of the same clip.
- **Project deletion is manual only.** The dashboard and project page offer a confirmation dialog. Deletion removes the complete `projects/{projectId}/` key scope on every configured provider plus legacy R2/local files and local upload staging. It removes the D1 transcript/clip/job/project rows only after every storage backend confirms deletion. A failed deletion leaves the project and failed-object ledger records visible, names the files that remain, and can be retried. ZIP exports are generated on demand and are not stored as separate objects.

### Verified large-file runs

These runs used the local-first path in headless Chromium (WASM CPU inference, no WebGPU). Each source is a real 330-second, 1280×720/24 fps H.264/AAC MP4 with the real-speech audio track from the smoke fixture; the picture is a repeated test pattern and timecode, not production footage. Sizes are decimal MB. Peak RSS is the sum of the browser process tree during polling, and processing time runs from the first processing update through verification of the last clip.

| Source | IndexedDB store | Processing | Peak RSS | Verified clips | Captions / MP4 | ZIP | Source in R2 |
| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| 250 MB (248,860,505 B) | 0.26 s | 4m 06s | 1,757 MB | 6 | yes | 22.7 MB | no |
| 500 MB (498,682,773 B) | 0.19 s | 4m 11s | 1,789 MB | 6 | yes | 22.7 MB | no |
| 750 MB (748,507,626 B) | 0.21 s | 4m 20s | 1,646 MB | 6 | yes | 22.6 MB | no |
| 1 GB (998,329,807 B) | 0.24 s | 4m 21s | 1,714 MB | 6 | yes | 22.7 MB | no |

All four runs passed, including the 1 GB run. The 1 GB row is the final rerun after the IndexedDB commit fix; the 250–750 MB runs used the same processing path before that handoff-only fix. The local save time measures handing the `File` to IndexedDB, not copying bytes over the network. All 24 clips across the four runs probe as 1080×1920 H.264 with AAC audio and 12–22 burned-in caption cues; every MP4 was downloaded and probed, and every ZIP was opened and checked. The D1 `source_path` was `local://<projectId>` and the storage API reported **0 source bytes** in every run. The selector returned six clips rather than eight because the repeated test audio does not contain eight distinct strong moments; it correctly did not pad.

The 1 GB file was **998,329,807 bytes (952.1 MiB)**, below the 1 GiB policy ceiling. If the encoder hits a browser memory or GPU-process limit, the project fails with the real error and any already-finished clips remain downloadable; it is not marked successful.

These are browser-runtime measurements, not a hardware guarantee. A machine with less than roughly 2.5–3 GB available to Chromium may fail at long durations even when the file is within the policy ceiling. The render cost depends more on output duration, resolution and filter complexity than on source byte count alone.
- If the source has no audio track, processing fails with `no_audio_track`; no clips are invented.
- If the model cannot provide word timestamps, the run fails and shows the actual model error.
- If a clip upload or FFmpeg encode fails, the project is marked failed with the real message and existing completed clips remain downloadable.
- A late progress update cannot turn a failed project back into “processing”.
- No arbitrary YouTube download is implemented. YouTube’s API returns metadata, not video files, and extractors are intentionally not used. Attach a copy you own or are authorized to use; an operator can configure the authorized-directory provider.

## Storage and security

- Source paths and remote object keys are resolved only after an owner check (`getProjectForOwner` / `getClipForOwner`).
- A local-first project stores only a `local://<projectId>` marker on the server. The source download route rejects that marker instead of inventing a server file. Authorized remote-source projects still stream through an owner-scoped route.
- Finished clips are never public. Provider credentials exist only in server-side environment secrets; they are never stored in D1, included in an object path, or sent to the browser. In production the pool uses the configured S3 endpoints; legacy data uses the `FILES` binding. Local development uses `AC_DATA_DIR`.
- The optional server-copy API uses 8 MB multipart parts, retries one failed part without restarting the upload, and verifies the completed object’s HEAD size before changing the project source path. It never exposes provider credentials to the browser. Its start route atomically reserves capacity and refuses a source copy that cannot fit. Pool uploads use versioned keys, so the old source/clip object is not deleted until the replacement is complete and verified. `POST /api/projects/:id/source/multipart/abort` releases an explicitly abandoned provider/R2 multipart upload; reservation expiry (24 hours by default) aborts abandoned pool multipart sessions and releases their capacity. Local staging older than 24 hours is removed automatically.
- Uploads are written through authenticated server routes, not browser-to-provider presigned URLs. This keeps credentials off the client but adds the 95 MB clip ceiling. Each completed pool upload is verified with a HEAD request before it is marked complete.
- **Upload progress scope:** the normal path performs no network upload, so there is no upload percentage or ETA to display. The dashboard shows the local save state and the project page shows live transcription/encoding progress. The optional multipart API is server/API-only and was not part of the browser large-file runs.
- Accounts: scrypt password hashes, hashed single-use email/reset tokens, HTTP-only session cookies and origin checks.
- Existing ownership tests cover cross-account project/clip visibility. Storage reads and deletes are scoped to the authenticated owner's project prefix.
- The real B2, Tigris and Filebase endpoints have **not** been exercised: no provider credentials, buckets, deployment or file migration were created. The pool is tested against a local S3-compatible mock that now validates SigV4, payload hashes and timestamps, plus multipart part retry, reservation expiry/abort, concurrent capacity, range streaming on all three providers, cross-provider ZIP export and deletion retry. D1’s SQL is the same as the locally exercised SQLite statement, but no deployed D1 instance was available to run the concurrency test. The dashboard’s “other bucket usage” is the difference between the dedicated bucket listing and complete AutoClipper objects; it is not account-wide billing usage. The legacy R2 deletion/retry path is covered with an injected bucket; the production managed bucket has not been written to. The four large-file browser runs used the local SQLite/filesystem backend for clips and project data; the source itself stayed in browser IndexedDB and never depended on either backend.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/projects` | Create upload or YouTube-linked project |
| `POST` | `/api/projects/:id/source/multipart/start` | Start an 8 MB-part source upload |
| `PUT` | `/api/projects/:id/source/multipart/part` | Upload one source part |
| `POST` | `/api/projects/:id/source/multipart/complete` | Assemble the source |
| `POST` | `/api/projects/:id/source/multipart/abort` | Abort an abandoned multipart upload |
| `GET` | `/api/projects/:id/source/download` | Owner-only source stream for the browser worker |
| `POST` | `/api/projects/:id/process` | Browser worker: start, progress, transcript, selection, complete, fail |
| `GET` | `/api/projects/:id/processor` | Hydrate a worker with source and saved transcript |
| `PUT` | `/api/clips/:id/upload` | Upload a finished MP4/poster through an authenticated route |
| `POST` | `/api/clips/:id/finalize` | Verify the upload and mark the clip rendered |
| `PATCH` | `/api/clips/:id` | Save edits; the browser then re-renders the clip |
| `POST` | `/api/clips/:id/regenerate` | Reset to the original edit plan for a browser re-render |
| `GET` | `/api/projects/:id/download` | Owner-only ZIP of rendered clips |
| `GET` | `/api/clips/:id/video` | Range-capable MP4 stream/download |
| `GET` | `/api/storage` | Owner-scoped actual storage usage and remaining space |
| `DELETE` | `/api/projects/:id` | Delete project objects on every provider plus legacy files, then D1 records; returns per-file failures |
| `POST` | `/api/projects/:id/start` | Disabled legacy queue endpoint (returns 409) |

## Editing

Clip edits are persisted in D1: source range, replacement caption text, camera-move enable/intensity and slow-motion enable. **Save & re-render** saves the edits and calls the same browser worker used for the initial run. Regenerate clears the overrides and re-runs the explainable plan. The browser artifact is replaced only after the new MP4 uploads successfully.

## Accounts and YouTube

Email/password accounts use scrypt hashing, case-insensitive unique email keys and HTTP-only sessions. Email verification and password reset use hashed single-use tokens; configure Resend to actually send mail. Google sign-in is optional and links only through a verified email.

YouTube links are metadata-only by default. Set `YOUTUBE_CONTENT_PROVIDER=authorized-directory` and place authorized files in `YOUTUBE_MEDIA_DIR` named by video id to enable the one-step path. See `.env.example`.

## Fit for two full-length uploads a day

One user, about two full-length uploads a day, no shared quota. Each upload is scored and clipped independently; the target is eight strong clips and the hard cap is ten, with no filler. The measured 20-minute run took 6m51s of tab time on WASM CPU, so two 20-minute uploads are roughly 14 minutes plus the one-time Whisper model download; framing now adds a short per-clip sampling pass. The tab must stay open. There is no processing server, paid API, subscription or credit card.

## Testing

```bash
npm run typecheck
npm test
npm run build
```

Verified locally on 2026-11-05:

- 87 tests pass, including real native-FFmpeg rendering tests for the shared edit/caption/crop modules, quality-gated selection, short-source fallback, subject-following animated crop and input-seeked clip rendering.
- The storage tests verify actual local file accounting, project-scoped deletion, local upload-staging cleanup, a simulated R2 failure that keeps the project record and reports the exact remaining file, retry success, and explicit transcript/clip/job cleanup. The S3 mock additionally verifies B2-first spillover through Tigris and Filebase, atomic capacity refusal under concurrent uploads, retry after a failed PUT without duplicate attachment, a failed multipart part being retried independently, abandoned multipart abort/reservation release, resumable multipart assembly, HEAD verification, range streaming on all three providers, cross-provider ZIP export, cross-provider deletion retry, and unavailable-provider reporting. Signature tests cover the AWS vector, path- and virtual-hosted URLs, wrong secrets, tampered payloads, stale timestamps and signed payload hashes. No real provider bucket and no production R2 bucket was mutated because no deployment or migration was made.
- Production build passes.
- Real headless-Chromium E2E (WASM CPU, no WebGPU): automatic start after upload; a 10-second, 640×360 moving-subject fixture produced 1 clip at 1080×1920 in 35.4 s, with a subject-following pan from −0.63 to +0.55, 6 burned-in caption cues, 0 browser errors and 1.54 GB peak browser process-tree RSS. The exported start and end frames were inspected and the subject stayed visible. An earlier 20-minute / 135 MB repeated-JFK run produced 8 clips, a 79.7 MB ZIP and 1.97 GB peak before the quality/diversity gate; the same transcript now returns 2 distinct clips by design, while varied long transcripts return 8–10.
- The desktop cloud browser panel previously canceled anchor/Blob downloads (`canceled`) even though the server returned valid MP4 and ZIP files. Server responses were verified with `ffprobe` and `unzip`; the Playwright run downloaded the ZIP successfully.

## Legacy files

`worker/index.ts`, `src/lib/pipeline.ts`, `src/lib/media/ffmpeg.ts`, the Faster-Whisper helper and the old tests remain in the tree for reference and shared pure-module tests. They are not started by any npm script and `/api/projects/:id/start` is disabled. No paid service or separate processing process is required.

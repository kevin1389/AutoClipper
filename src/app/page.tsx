import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/site-header';

const STEPS = [
  {
    title: 'Bring the recording',
    body: 'Upload an MP4, MOV, WebM or MKV file. YouTube links are validated and previewed, with an upload hand-off when media access is not authorized.',
  },
  {
    title: 'Transcribe and score',
    body: 'Speech becomes a timestamped transcript. A selector scores hooks, stories, numbers and emotional beats, then proposes 5–10 self-contained moments.',
  },
  {
    title: 'Render and export',
    body: 'FFmpeg cuts each moment to 1080×1920, burns word-synced captions and writes real MP4 files you can preview and download individually or as a ZIP.',
  },
];

const CAPABILITIES = [
  {
    title: 'Vertical reframing',
    body: 'Every clip is recomposed to 9:16 at 1080×1920. A smooth subject-aware pan follows the dominant person or high-contrast detail, falling back to a stable center crop when the evidence is weak — no stretching, no letterboxing.',
  },
  {
    title: 'Synchronized captions',
    body: 'Word-level timings drive ASS karaoke captions that fill in as speech lands, burned directly into the video.',
  },
  {
    title: 'Transcript-grounded titles',
    body: 'Clip titles, hooks and timestamps come from the transcript itself, so what you read matches what you hear.',
  },
  {
    title: 'Real files, real statuses',
    body: 'A project only reaches “completed” when MP4 files exist on disk. Every stage reports progress or a specific failure.',
  },
  {
    title: 'Pluggable providers',
    body: 'Transcription and selection are interfaces. Swap the OpenAI-compatible endpoint, model, or the deterministic selector without touching rendering.',
  },
  {
    title: 'Background processing',
    body: 'Long jobs run in a separate worker process with persisted state, heartbeats and retries — the request never blocks on FFmpeg.',
  },
];

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-ink-800">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{
              background:
                'radial-gradient(60% 60% at 15% 0%, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0) 60%), radial-gradient(50% 50% at 85% 20%, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 70%)',
            }}
          />
          <div className="relative mx-auto grid w-full max-w-6xl gap-14 px-5 py-16 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 lg:py-24">
            <div className="max-w-xl">
              <span className="chip">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                AI video clipping platform
              </span>
              <h1 className="text-balance-tight mt-6 text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-[3.4rem]">
                Long recordings in.
                <br />
                Scroll-stopping vertical clips out.
              </h1>
              <p className="mt-6 text-base leading-relaxed text-mist-300 sm:text-[17px]">
                AutoClipper transcribes your video, finds the moments worth watching, and renders real
                9:16 MP4 files with synchronized captions. No mock previews, no placeholder downloads.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link href="/dashboard" className="btn-primary px-5 py-3 text-[15px]">
                  Start clipping
                  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M3 8h9m0 0L8.5 4.5M12 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
                <Link href="/#how" className="btn-secondary px-5 py-3 text-[15px]">
                  See how it works
                </Link>
              </div>
              <dl className="mt-10 grid max-w-md grid-cols-3 gap-4 border-t border-ink-800 pt-6">
                {[
                  ['9:16', 'Output format'],
                  ['5–10', 'Clips per video'],
                  ['MP4', 'Real file output'],
                ].map(([value, label]) => (
                  <div key={label}>
                    <dt className="font-mono text-lg font-semibold text-white">{value}</dt>
                    <dd className="mt-0.5 text-[11px] uppercase tracking-[0.12em] text-mist-500">{label}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Pipeline illustration */}
            <div className="relative">
              <div className="panel p-5 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 animate-pulse-soft rounded-full bg-sky-400" />
                    <span className="text-xs font-semibold uppercase tracking-[0.14em] text-mist-400">
                      Processing
                    </span>
                  </div>
                  <span className="font-mono text-xs text-mist-400">62%</span>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-700">
                  <div className="h-full w-[62%] rounded-full bg-white" />
                </div>
                <ul className="mt-5 space-y-3 text-sm">
                  {[
                    ['Inspect source', 'done', '1920×1080 · 14:22'],
                    ['Extract audio', 'done', '16 kHz mono'],
                    ['Transcribe', 'done', '2,418 words'],
                    ['Find highlights', 'active', 'Scoring candidate moments'],
                    ['Render clips', 'pending', '9:16 · burned-in captions'],
                  ].map(([label, state, meta]) => (
                    <li key={label} className="flex items-center gap-3">
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                          state === 'done'
                            ? 'border-emerald-500/30 bg-emerald-500/10'
                            : state === 'active'
                              ? 'border-white/25 bg-white/10'
                              : 'border-ink-600 bg-ink-850'
                        }`}
                      >
                        {state === 'done' ? (
                          <svg viewBox="0 0 16 16" className="h-2.5 w-2.5 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="2.2">
                            <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : state === 'active' ? (
                          <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-white/30 border-t-white" />
                        ) : (
                          <span className="h-1 w-1 rounded-full bg-ink-500" />
                        )}
                      </span>
                      <span className={state === 'pending' ? 'text-mist-500' : 'text-mist-200'}>{label}</span>
                      <span className="ml-auto hidden font-mono text-[11px] text-mist-500 sm:block">{meta}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-4 flex items-center gap-3 rounded-2xl border border-ink-700/70 bg-ink-900/60 p-3">
                <div className="relative aspect-[9/16] w-14 shrink-0 overflow-hidden rounded-lg bg-gradient-to-b from-ink-600 via-ink-750 to-ink-900">
                  <div className="absolute inset-x-0 bottom-1.5 text-center text-[5px] font-black uppercase leading-tight tracking-tight text-white">
                    This is
                    <br />
                    the hook
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-mist-200">Caption style preview</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-mist-500">
                    Word-synced karaoke captions are burned into each render. 1080×1920, H.264.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="border-b border-ink-800">
          <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 lg:py-24">
            <div className="max-w-2xl">
              <p className="label">How it works</p>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                Three stages, one honest status trail
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-mist-400 sm:text-base">
                Each stage writes its result to the project record. If transcription is unconfigured or a
                render fails, the project says so — it never reports success without files.
              </p>
            </div>
            <ol className="mt-10 grid gap-4 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="panel flex flex-col gap-3 p-6">
                  <span className="font-mono text-xs text-mist-500">0{index + 1}</span>
                  <h3 className="text-base font-semibold text-white">{step.title}</h3>
                  <p className="text-sm leading-relaxed text-mist-400">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Capabilities */}
        <section id="pipeline" className="border-b border-ink-800">
          <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 lg:py-24">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div className="max-w-xl">
                <p className="label">The pipeline</p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  Built like a processing system, not a demo
                </h2>
              </div>
              <p className="max-w-sm text-sm leading-relaxed text-mist-400">
                Next.js UI and API, a dedicated FFmpeg worker, SQLite for project state, and files on
                disk. Every stage can be tested on its own.
              </p>
            </div>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map((capability) => (
                <article key={capability.title} className="panel p-6 transition-colors hover:border-ink-600">
                  <h3 className="text-sm font-semibold text-white">{capability.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-mist-400">{capability.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Honest limits */}
        <section id="limits" className="border-b border-ink-800">
          <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 lg:py-24">
            <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
              <div>
                <p className="label">Honest limits</p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  What this version does not do
                </h2>
                <p className="mt-4 text-sm leading-relaxed text-mist-400">
                  These are deliberate boundaries, not hidden failures. Each one has a clear path
                  forward in the codebase.
                </p>
              </div>
              <dl className="space-y-4">
                {[
                  {
                    term: 'No YouTube media download',
                    detail:
                      'Links are validated and previewed via YouTube’s public oEmbed metadata. Fetching YouTube video files needs an authorized access agreement, so AutoClipper hands you an upload form instead of pretending.',
                  },
                  {
                    term: 'Subject-aware, not face-aware',
                    detail:
                      'Reframing estimates the dominant subject from sampled RGB skin tone and visual detail, then eases the crop toward it. It is not face recognition, active-speaker detection or diarization; weak evidence falls back to a stable center crop. A dedicated face or speaker model can plug into the crop planner without changing the renderer.',
                  },
                  {
                    term: 'No billing',
                    detail:
                      'Sign in with Google or an email and password; every project, file and clip is scoped to its owner. There is no subscription or payment layer.',
                  },
                ].map((item) => (
                  <div key={item.term} className="panel p-5">
                    <dt className="text-sm font-semibold text-white">{item.term}</dt>
                    <dd className="mt-2 text-sm leading-relaxed text-mist-400">{item.detail}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="bg-ink-950">
          <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 lg:py-20">
            <div className="panel relative overflow-hidden px-6 py-12 text-center sm:px-12">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    'radial-gradient(50% 120% at 50% 0%, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0) 70%)',
                }}
              />
              <div className="relative">
                <h2 className="text-balance-tight text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  Turn one recording into a week of clips
                </h2>
                <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-mist-400">
                  Upload a file, watch the pipeline run, then download every clip as an MP4 or grab the
                  whole set as a ZIP.
                </p>
                <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
                  <Link href="/dashboard" className="btn-primary px-5 py-3">
                    Open the dashboard
                  </Link>
                  <Link href="/api/health" className="btn-secondary px-5 py-3">
                    Check system status
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

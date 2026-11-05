/**
 * AutoClipper background worker.
 *
 * Claims queued jobs from the SQLite database and runs the media pipeline.
 * FFmpeg work is CPU bound and long running, so this is a separate process from
 * the Next.js server:
 *
 *   npm run worker        # long-lived
 *   npm run worker:once   # process a single queued job (used by the smoke test)
 */
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from '../src/lib/load-env';
import * as db from '../src/lib/db-sqlite';
import { config, processingBlocker } from '../src/lib/env';
import { PipelineError, runPipeline } from '../src/lib/pipeline';
import { MediaToolMissingError } from '../src/lib/media/ffmpeg';

const VERSION = '0.1.0';
const POLL_INTERVAL_MS = 2_000;

function log(message: string): void {
  process.stdout.write(`[worker ${new Date().toISOString()}] ${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  loadEnvFile();

  const once = process.argv.includes('--once');
  const cfg = config();
  const workerId = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

  log(`starting ${workerId}`);
  log(`ffmpeg:  ${cfg.ffmpegPath ?? 'NOT FOUND'}`);
  log(`ffprobe: ${cfg.ffprobePath ?? 'NOT FOUND'}`);
  log(`data:    ${cfg.dataDir}`);

  const blocker = processingBlocker();
  if (blocker) {
    log(`WARNING: ${blocker.message}`);
  }

  await db.getDb();
  let stopping = false;
  let currentJobId: string | null = null;

  process.on('SIGINT', () => {
    log('SIGINT received, finishing current job then exiting');
    stopping = true;
  });
  process.on('SIGTERM', () => {
    log('SIGTERM received, finishing current job then exiting');
    stopping = true;
  });

  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        await db.recordWorkerHeartbeat(workerId, VERSION);
        if (currentJobId) await db.heartbeatJob(currentJobId);
      } catch (error) {
        log(`heartbeat failed: ${(error as Error).message}`);
      }
    })();
  }, 10_000);
  await db.recordWorkerHeartbeat(workerId, VERSION);

  try {
    while (!stopping) {
      const job = await db.claimNextJob(workerId);
      if (!job) {
        if (once) break;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      currentJobId = job.id;
      const project = await db.getProject(job.projectId);
      log(`claimed job ${job.id} for project ${job.projectId} (${project?.title ?? 'unknown'})`);

      try {
        const result = await runPipeline({ projectId: job.projectId });
        await db.finishJob(job.id);
        log(
          `project ${job.projectId}: ${result.renderedCount}/${result.clipCount} clips rendered ` +
            `(transcription: ${result.transcriptProvider}; selection: ${result.selectionEngine})`,
        );
      } catch (error) {
        const pipelineError = error instanceof PipelineError ? error : null;
        const mediaMissing = error instanceof MediaToolMissingError;
        const message = error instanceof Error ? error.message : String(error);

        await db.updateProject(job.projectId, {
          status: 'failed',
          error: message.slice(0, 1500),
          statusDetail: null,
        });
        await db.failJob(job.id, message, pipelineError?.hint ?? null);
        log(`project ${job.projectId} FAILED: ${message}`);

        const canRetry =
          !mediaMissing && pipelineError?.retryable === true && job.attempts < job.maxAttempts;
        if (canRetry) {
          await db.requeueJob(job.id);
          await db.updateProject(job.projectId, {
            status: 'queued',
            statusDetail: `Retrying after a transient error (attempt ${job.attempts + 1} of ${job.maxAttempts})`,
          });
          log(`job ${job.id} requeued for retry (attempt ${job.attempts + 1}/${job.maxAttempts})`);
          await sleep(3_000);
        }
      } finally {
        currentJobId = null;
      }

      if (once) break;
    }
  } finally {
    clearInterval(heartbeat);
    log('stopped');
    await db.closeDb();
  }
}

void main().catch((error) => {
  process.stderr.write(`[worker] fatal: ${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});

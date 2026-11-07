import { isJpeg } from '../poster';

/**
 * Captures a poster on the main thread with a real HTMLVideoElement and canvas.
 * FFmpeg.wasm cannot decode every clip it renders (some inputs trap the wasm
 * decoder), while the browser's native decoder handles the same MP4 reliably.
 */
export async function capturePosterFromVideo(videoBytes: ArrayBuffer): Promise<Uint8Array> {
  if (typeof document === 'undefined') {
    throw new Error('Poster capture requires a browser page.');
  }

  const url = URL.createObjectURL(new Blob([videoBytes], { type: 'video/mp4' }));
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;

  try {
    video.src = url;
    video.load();
    await waitForVideoEvent(
      video,
      'loadedmetadata',
      15_000,
      'The browser could not open the rendered clip for its poster.',
    );

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = Math.min(1, Math.max(0, duration > 0 ? duration - 0.05 : 0));
    if (target > 0.01) {
      video.currentTime = target;
      await waitForVideoEvent(
        video,
        'seeked',
        15_000,
        'The browser could not seek to the poster frame.',
      );
    } else if (video.readyState < 2) {
      await waitForVideoEvent(
        video,
        'loadeddata',
        15_000,
        'The browser could not decode a frame for the poster.',
      );
    }

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('The rendered clip reported no video dimensions for its poster.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not create a canvas for the poster.');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const posterBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('The browser could not encode the poster as a JPEG.'));
        },
        'image/jpeg',
        0.9,
      );
    });

    const poster = new Uint8Array(await posterBlob.arrayBuffer());
    if (!isJpeg(poster)) {
      throw new Error('The browser produced an invalid poster image.');
    }
    return poster;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
    video.load();
  }
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  event: 'loadedmetadata' | 'loadeddata' | 'seeked',
  timeoutMs: number,
  message: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(message));
    }, timeoutMs);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('The browser could not decode the rendered clip for its poster.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, onReady);
      video.removeEventListener('error', onError);
    };
    video.addEventListener(event, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

import fsp from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const assetDir = path.join(root, 'browser-assets');

async function copy(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
}

async function main() {
  // These files are served by the browser-asset host, never by the Worker
  // bundle: Cloudflare rejects every file above 25 MiB, and the full set is
  // ~205 MB. `browser-assets/models/` is checked in; the rest is generated.
  const ffmpegCore = path.join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
  await copy(path.join(ffmpegCore, 'ffmpeg-core.js'), path.join(assetDir, 'ffmpeg', 'ffmpeg-core.js'));
  await copy(path.join(ffmpegCore, 'ffmpeg-core.wasm'), path.join(assetDir, 'ffmpeg', 'ffmpeg-core.wasm'));

  await copy(
    path.join(root, 'assets', 'fonts', 'DejaVuSans-Bold.ttf'),
    path.join(assetDir, 'fonts', 'DejaVuSans-Bold.ttf'),
  );

  const ort = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
  for (const entry of await fsp.readdir(ort)) {
    if (!/\.(wasm|mjs)$/.test(entry)) continue;
    if (!/^ort-wasm/.test(entry)) continue;
    await copy(path.join(ort, entry), path.join(assetDir, 'transformers', entry));
  }

  await fsp.writeFile(
    path.join(assetDir, 'browser-assets.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

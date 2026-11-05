import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const publicDir = path.join(root, 'public');

async function copy(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
}

async function main() {
  // The ffmpeg wrapper worker is created as a module worker. It cannot use
  // importScripts(), so it dynamic-imports the ESM core and expects a default
  // export. Copying the UMD build here would load successfully as a module but
  // expose no createFFmpegCore function.
  const ffmpegCore = path.join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
  await copy(path.join(ffmpegCore, 'ffmpeg-core.js'), path.join(publicDir, 'ffmpeg', 'ffmpeg-core.js'));
  await copy(path.join(ffmpegCore, 'ffmpeg-core.wasm'), path.join(publicDir, 'ffmpeg', 'ffmpeg-core.wasm'));

  await copy(
    path.join(root, 'assets', 'fonts', 'DejaVuSans-Bold.ttf'),
    path.join(publicDir, 'fonts', 'DejaVuSans-Bold.ttf'),
  );

  const ort = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
  for (const entry of await fsp.readdir(ort)) {
    if (!/\.(wasm|mjs)$/.test(entry)) continue;
    if (!/^ort-wasm/.test(entry)) continue;
    await copy(path.join(ort, entry), path.join(publicDir, 'transformers', entry));
  }

  // A tiny marker makes it obvious whether the deployment step ran.
  await fsp.writeFile(
    path.join(publicDir, 'browser-assets.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

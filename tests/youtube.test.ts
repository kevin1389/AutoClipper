import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYoutubeUrl, contentAccessReason } from '../src/lib/youtube';

test('accepts every common YouTube video URL shape', () => {
  const cases = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4',
    'http://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=42',
    'https://youtu.be/dQw4w9WgXcQ/',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'www.youtube.com/watch?v=dQw4w9WgXcQ',
    '  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ',
  ];

  for (const input of cases) {
    const parsed = parseYoutubeUrl(input);
    assert.ok(parsed, `expected to parse: ${input}`);
    assert.equal(parsed?.videoId, 'dQw4w9WgXcQ');
    assert.equal(parsed?.canonicalUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  }
});

test('rejects non-YouTube links and malformed ids', () => {
  const cases = [
    '',
    'not a url',
    'https://vimeo.com/123456',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/channel/UC123',
    'https://www.youtube.com/watch?v=tooShort',
    'https://www.youtube.com/watch?v=',
    'javascript:alert(1)',
    'ftp://www.youtube.com/watch?v=dQw4w9WgXcQ',
  ];

  for (const input of cases) {
    assert.equal(parseYoutubeUrl(input), null, `expected to reject: ${input}`);
  }
});

test('content access is explicitly reported as unavailable without a provider', () => {
  const reason = contentAccessReason('none');
  // The explanation must distinguish metadata from media, and must not imply a
  // workaround: the missing piece is the user's own authorized file.
  assert.match(reason, /Data API/i);
  assert.match(reason, /metadata/i);
  assert.match(reason, /Terms of Service/i);
  assert.match(reason, /authorized/i);
  assert.match(reason, /no downloadable video file/i);
});

test('a configured provider is reported as unimplemented instead of silently ignored', () => {
  const reason = contentAccessReason('acme-licensing');
  assert.match(reason, /acme-licensing/);
  assert.match(reason, /no media-fetch implementation/i);
});

import CDP from 'chrome-remote-interface';
import { writeFileSync } from 'fs';

const TAB = process.argv[2] || '787309E6BEC689839ADE3DC724FEBB2F';
const URL = `ws://127.0.0.1:9222/devtools/page/${TAB}`;
const OUT = process.argv[3] || 'game-screenshot.png';

const client = await CDP({ target: URL });
try {
  const { Page } = client;
  await Page.enable();
  const { data } = await Page.captureScreenshot({ format: 'png', fromSurface: true });
  writeFileSync(OUT, Buffer.from(data, 'base64'));
  console.log('saved', OUT, data.length, 'bytes base64');
} finally {
  await client.close();
}

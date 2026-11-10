import { BrowserUse } from 'browser-use-sdk';

const apiKey = process.env.BROWSER_USE_API_KEY;
if (!apiKey) {
  console.error(JSON.stringify({ ok: false, error: 'Set BROWSER_USE_API_KEY environment variable.' }));
  process.exit(1);
}

const client = new BrowserUse({ apiKey });
const task = process.env.CLOUD_TASK || 'Find the title of the top story on Hacker News and report it.';
const model = process.env.CLOUD_MODEL || 'grok-4.5';

try {
  const result = await client.run(task, { model });
  console.log(JSON.stringify({ ok: true, task, model, result: result.result, taskId: result.taskId }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, statusCode: error.statusCode }, null, 2));
  process.exit(1);
}

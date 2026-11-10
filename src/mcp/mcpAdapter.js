export const mcpToolMap = {
  browser_screenshot: 'browser.screenshot',
  browser_click: 'browser.click',
  browser_click_selector: 'browser.clickSelector',
  browser_key: 'browser.key',
  browser_scroll: 'browser.scroll',
  browser_hover: 'browser.hover',
  browser_mousemove: 'browser.mousemove',
  browser_mousedown: 'browser.mousedown',
  browser_mouseup: 'browser.mouseup',
  browser_list_tabs: 'browser.listTabs',
  browser_select_tab: 'browser.selectTab',
  browser_create_tab: 'browser.createTab',
  browser_info: 'browser.info',
  browser_type_fast: 'browser.typeFast',
  browser_type: 'browser.type',
  browser_type_selector: 'browser.typeSelector',
  browser_select_option: 'browser.selectOption',
  browser_drag: 'browser.drag',
  browser_dom_snapshot: 'browser.domSnapshot',
  browser_inspect_element: 'browser.inspectElement',
  browser_get_state: 'browser.getState',
  browser_console_logs: 'browser.consoleLogs',
  browser_network_logs: 'browser.networkLogs',
  browser_failed_requests: 'browser.failedRequests',
  browser_action_trace: 'browser.actionTrace',
  browser_navigate: 'browser.navigate',
  browser_evaluate: 'browser.evaluate',
  browser_wait_for_selector: 'browser.waitForSelector',
  browser_wait_for_timeout: 'browser.waitForTimeout',
  browser_assert_no_console_errors: 'browser.assertNoConsoleErrors',
  browser_assert_visible: 'browser.assertVisible',
  browser_assert_text: 'browser.assertText',
  session_get_events: 'session.getEvents',
  session_stop: 'session.stop'
};

export const resources = [
  { uri: 'browser-use://session/state', name: 'Session state', mimeType: 'application/json' },
  { uri: 'browser-use://browser/current', name: 'Browser current info', mimeType: 'application/json' },
  { uri: 'browser-use://browser/console', name: 'Captured console logs', mimeType: 'application/json' },
  { uri: 'browser-use://browser/network', name: 'Captured network logs', mimeType: 'application/json' },
  { uri: 'browser-use://browser/actions', name: 'Action trace', mimeType: 'application/json' },
  { uri: 'browser-use://session/events', name: 'Recent session events', mimeType: 'application/json' }
];

import { readFile } from 'node:fs/promises';

export const prompts = [
  { name: 'browser_use_agent_card', description: 'Authoritative browser-use MCP connection and tool-use instructions for agents.' },
  { name: 'drive_browser_goal', description: 'Drive the browser toward a goal.' },
  { name: 'inspect_current_page', description: 'Inspect current DOM, console, and network state.' },
  { name: 'verify_browser_task', description: 'Verify a browser task with screenshots and diagnostics.' },
  { name: 'recover_from_failed_action', description: 'Recover from a failed browser action using action evidence.' },
  { name: 'summarize_browser_session', description: 'Summarize the current browser action trace.' }
];

const AGENT_CARD_PATH = new URL('./prompts/browser-use-agent-card.md', import.meta.url);

export async function getPrompt(name) {
  if (name !== 'browser_use_agent_card') return null;
  const text = await readFile(AGENT_CARD_PATH, 'utf8');
  return {
    description: 'Authoritative browser-use MCP connection and tool-use instructions for agents.',
    messages: [{ role: 'user', content: { type: 'text', text } }]
  };
}

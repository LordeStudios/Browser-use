/* Responsive tab packing is shared by the shell and deterministic tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrowserUseTabStrip = api;
})(globalThis, () => {
  const MIN_TAB_WIDTH = 44;
  const GROUP_WIDTH = 40;
  const PREFERRED_WIDTH = 220;
  function layout(tabs, selectedId, availableWidth) {
    const width = Math.max(0, Number(availableWidth) || 0);
    const count = tabs.length;
    if (!count) return { visible: [], hidden: [], tabWidth: 0, groupWidth: 0 };
    if (count * MIN_TAB_WIDTH <= width) return { visible: tabs, hidden: [], tabWidth: Math.min(PREFERRED_WIDTH, width / count), groupWidth: 0 };
    const groupWidth = Math.min(GROUP_WIDTH, width);
    const visibleCount = Math.max(0, Math.min(count - 1, Math.floor((width - groupWidth) / MIN_TAB_WIDTH)));
    let visible = tabs.slice(0, visibleCount);
    const selected = tabs.find(tab => tab.id === selectedId);
    if (visibleCount && selected && !visible.includes(selected)) visible = [...visible.slice(0, -1), selected];
    const ids = new Set(visible.map(tab => tab.id));
    const hidden = tabs.filter(tab => !ids.has(tab.id));
    return { visible, hidden, tabWidth: visibleCount ? Math.min(PREFERRED_WIDTH, (width - groupWidth) / visibleCount) : 0, groupWidth };
  }
  return { layout, MIN_TAB_WIDTH, GROUP_WIDTH, PREFERRED_WIDTH };
});

import { readFileSync, writeFileSync } from 'node:fs';

const file = 'cli/tui/App.mjs';
const lines = readFileSync(file, 'utf8').split('\n');

// Line 884 (index 883): fix the header logo text
lines[883] = lines[883].replace("'\\u25b8_ browser-use'", "'\\u25b8 browser-use'");

// Line 1040 (index 1039): replace '=' bars with '─' bars (top composer bar)
lines[1039] = lines[1039].replace(
  "h(Text, { color: theme.AccentDim }, '='.repeat(Math.max(8, cols - 2)))",
  "h(Text, { color: theme.border.default }, '\\u2500'.repeat(Math.max(8, cols - 2)))"
);

// Line 1047 (index 1046): replace '=' bars with '─' bars (bottom composer bar)
lines[1046] = lines[1046].replace(
  "h(Text, { color: theme.AccentDim }, '='.repeat(Math.max(8, cols - 2)))",
  "h(Text, { color: theme.border.default }, '\\u2500'.repeat(Math.max(8, cols - 2)))"
);

// Lines 988-990 (indices 987-989): improve footer layout
lines[987] = "  const footer = h(Box, { flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 2, paddingRight: 2 },";
lines[988] = "    h(Text, { color: theme.Dim }, truncate(sessionStatusBits(state.session).join(' \\u00b7 '), Math.max(20, cols - 30))),";
lines[989] = "    h(Text, { color: theme.Comment }, 'esc cancel \\u00b7 /help')";
// Insert closing paren as new line after 989
lines.splice(990, 0, "  );");

writeFileSync(file, lines.join('\n'));
console.log('TUI fixes applied successfully');
console.log('Line 884:', lines[883]);
console.log('Line 1040:', lines[1039]);
console.log('Line 1047:', lines[1046]);
console.log('Footer:', lines[987], lines[988], lines[989], lines[990]);

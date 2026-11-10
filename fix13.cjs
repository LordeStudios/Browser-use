// fix13.cjs — fix agent-continuity-regressions failure (a):
// workspaceFromTask catch block returns path.resolve(target) which normalizes
// String.raw double-backslashes to single. Instead derive the repo root by
// splitting on separators and truncating at uganda-art-pulse / lorde-design-studios,
// rejoining with the ORIGINAL separator style.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'desktop', 'agent', 'desktopChatAgent.cjs');
let src = fs.readFileSync(file, 'utf8');

const oldCatch = `  } catch {
    return { root: path.resolve(target), target: path.resolve(target) };
  }
}`;

const newCatch = `  } catch {
    const parts = target.split(/[\\\\/]+/).filter(Boolean);
    const rootIdx = parts.findIndex(p => /uganda-art-pulse|lorde-design-studios/i.test(p));
    if (rootIdx >= 0) {
      const sep = target.includes('\\\\\\\\') ? '\\\\\\\\' : target.includes('\\\\') ? '\\\\' : '/';
      return { root: parts.slice(0, rootIdx + 1).join(sep), target };
    }
    return { root: target, target };
  }
}`;

if (!src.includes(oldCatch)) {
  console.error('OLD CATCH NOT FOUND — aborting');
  process.exit(1);
}
src = src.replace(oldCatch, newCatch);
fs.writeFileSync(file, src, 'utf8');
console.log('fix13 applied: workspaceFromTask catch block now derives repo root preserving separator style');
console.log('VERIFY: node --check desktop/agent/desktopChatAgent.cjs');

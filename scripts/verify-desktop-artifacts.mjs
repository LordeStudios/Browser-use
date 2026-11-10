import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outputDir = path.join(root, 'desktop-release');
const artifactNames = [
  `Browser-use-${packageInfo.version}-setup.exe`,
  `Browser-use-${packageInfo.version}-portable.exe`
];
const unpackedExecutable = path.join(outputDir, 'win-unpacked', 'Browser-use.exe');

const missingArtifacts = artifactNames.filter((artifactName) => {
  const artifactPath = path.join(outputDir, artifactName);

  try {
    return !fs.statSync(artifactPath).isFile() || fs.statSync(artifactPath).size === 0;
  } catch {
    return true;
  }
});

try {
  if (!fs.statSync(unpackedExecutable).isFile() || fs.statSync(unpackedExecutable).size === 0) {
    missingArtifacts.push(path.join('win-unpacked', 'Browser-use.exe'));
  }
} catch {
  missingArtifacts.push(path.join('win-unpacked', 'Browser-use.exe'));
}

if (missingArtifacts.length > 0) {
  throw new Error(`Electron packaging did not produce required executable artifacts: ${missingArtifacts.join(', ')}`);
}

for (const artifactName of artifactNames) {
  console.log(path.resolve(outputDir, artifactName));
}
console.log(path.resolve(unpackedExecutable));

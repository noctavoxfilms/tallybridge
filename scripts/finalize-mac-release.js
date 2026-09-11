#!/usr/bin/env node

// A stapled DMG has different bytes than the file electron-builder originally
// used to generate its update metadata. Recreate the blockmaps and
// latest-mac.yml only after every DMG has been stapled.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { executeAppBuilderAsJson } = require('app-builder-lib/out/util/appBuilder');

const projectRoot = path.resolve(__dirname, '..');
const distDirectory = path.join(projectRoot, 'dist');
const { version } = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

const artifacts = [
  `TallyBridge-${version}.dmg`,
  `TallyBridge-${version}-arm64.dmg`,
].map((name) => {
  const filePath = path.join(distDirectory, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing release artifact: ${filePath}`);
  }
  return { name, filePath };
});

function checksum(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
}

async function main() {
  for (const artifact of artifacts) {
    await executeAppBuilderAsJson([
      'blockmap',
      '--input', artifact.filePath,
      '--output', `${artifact.filePath}.blockmap`,
    ]);
    artifact.size = fs.statSync(artifact.filePath).size;
    artifact.sha512 = checksum(artifact.filePath);
  }

  const [x64, arm64] = artifacts;
  const metadata = [
    `version: ${version}`,
    'files:',
    ...artifacts.flatMap((artifact) => [
      `  - url: ${artifact.name}`,
      `    sha512: ${artifact.sha512}`,
      `    size: ${artifact.size}`,
    ]),
    `path: ${x64.name}`,
    `sha512: ${x64.sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');

  fs.writeFileSync(path.join(distDirectory, 'latest-mac.yml'), metadata);
  console.log(`  ✓ Refreshed blockmaps and latest-mac.yml for ${version} (x64 + arm64)`);
}

main().catch((error) => {
  console.error(`✗ Could not finalize Mac update artifacts: ${error.message}`);
  process.exitCode = 1;
});

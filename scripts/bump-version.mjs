import { readFileSync, writeFileSync } from 'node:fs';

const nextVersion = process.argv[2];

if (!nextVersion || !/^\d+\.\d+\.\d+$/.test(nextVersion)) {
  console.error('Usage: pnpm release:bump <major.minor.patch>');
  process.exit(1);
}

const packageJsonPath = 'package.json';
const tauriConfigPath = 'src-tauri/tauri.conf.json';
const cargoTomlPath = 'src-tauri/Cargo.toml';
const cargoLockPath = 'src-tauri/Cargo.lock';

const packageJson = readJson(packageJsonPath);
const tauriConfig = readJson(tauriConfigPath);
const cargoToml = readText(cargoTomlPath);
const cargoLock = readText(cargoLockPath);

const currentVersions = [
  ['package.json', packageJson.version],
  ['src-tauri/tauri.conf.json', tauriConfig.version],
  ['src-tauri/Cargo.toml', matchVersion(cargoToml, /^version = "([^"]+)"/m, cargoTomlPath)],
  [
    'src-tauri/Cargo.lock',
    matchVersion(
      cargoLock,
      /\[\[package\]\]\r?\nname = "codex-quota"\r?\nversion = "([^"]+)"/,
      cargoLockPath,
    ),
  ],
];

const uniqueVersions = new Set(currentVersions.map(([, version]) => version));
if (uniqueVersions.size !== 1) {
  console.error('Version files are out of sync:');
  for (const [path, version] of currentVersions) {
    console.error(`- ${path}: ${version}`);
  }
  process.exit(1);
}

writeText(packageJsonPath, replaceJsonVersion(readText(packageJsonPath), nextVersion, packageJsonPath));
writeText(tauriConfigPath, replaceJsonVersion(readText(tauriConfigPath), nextVersion, tauriConfigPath));
writeText(cargoTomlPath, cargoToml.replace(/^version = "[^"]+"/m, `version = "${nextVersion}"`));
writeText(
  cargoLockPath,
  cargoLock.replace(
    /(\[\[package\]\]\r?\nname = "codex-quota"\r?\nversion = ")[^"]+(")/,
    `$1${nextVersion}$2`,
  ),
);

console.log(`Bumped codex-quota from ${[...uniqueVersions][0]} to ${nextVersion}`);

function readJson(path) {
  return JSON.parse(readText(path));
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function writeText(path, value) {
  writeFileSync(path, value, 'utf8');
}

function replaceJsonVersion(text, version, path) {
  if (!/^\s*"version":\s*"[^"]+"/m.test(text)) {
    console.error(`Could not find version in ${path}`);
    process.exit(1);
  }
  return text.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
}

function matchVersion(text, pattern, path) {
  const match = text.match(pattern);
  if (!match) {
    console.error(`Could not find version in ${path}`);
    process.exit(1);
  }
  return match[1];
}

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuild } from '@electron/rebuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const stageDir = path.join(rootDir, '.desktop-build', 'desktop-app');

// The frontend is already bundled into dist; only the local backend needs Node packages.
const SERVER_DEPENDENCIES = [
  '@anthropic-ai/claude-agent-sdk', '@iarna/toml', '@octokit/rest',
  '@openai/codex', '@openai/codex-sdk', '@vscode/ripgrep',
  'bcrypt', 'better-sqlite3', 'chokidar', 'cors', 'cross-spawn', 'express',
  'gray-matter', 'ignore', 'jsonwebtoken', 'mime-types', 'multer',
  'node-pty', 'web-push', 'ws',
];

const packageJson = JSON.parse(
  await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'),
);

function getElectronVersion() {
  try {
    return JSON.parse(
      readFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8'),
    ).version;
  } catch {
    try {
      return JSON.parse(
        readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'),
      ).packages['node_modules/electron'].version;
    } catch {
      throw new Error('Could not resolve an exact Electron version for desktop packaging.');
    }
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyRequired(relativePath) {
  const from = path.join(rootDir, relativePath);
  const to = path.join(stageDir, relativePath);
  if (!(await pathExists(from))) {
    throw new Error(`Required desktop build input is missing: ${relativePath}`);
  }
  await fs.cp(from, to, { recursive: true });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: stageDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function hasNodePtyPrebuild() {
  const prebuildDir = path.join(stageDir, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`);
  const requiredFiles = process.platform === 'win32'
    ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
    : process.platform === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node'];

  try {
    for (const file of requiredFiles) {
      await fs.access(path.join(prebuildDir, file));
    }
    if (process.platform === 'darwin') {
      await fs.chmod(path.join(prebuildDir, 'spawn-helper'), 0o755);
    }
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return false;
  }
}

function buildDesktopPackageJson() {
  return {
    name: `${packageJson.name}-desktop`,
    version: packageJson.version,
    productName: packageJson.productName,
    description: `${packageJson.productName} desktop app with bundled local server`,
    author: packageJson.author,
    license: packageJson.license,
    type: 'module',
    main: 'electron/main.js',
    dependencies: Object.fromEntries(SERVER_DEPENDENCIES.map((name) => {
      if (!packageJson.dependencies[name]) {
        throw new Error(`Missing desktop backend dependency: ${name}`);
      }
      return [name, packageJson.dependencies[name]];
    })),
    build: {
      appId: packageJson.build.appId,
      productName: packageJson.build.productName,
      asar: packageJson.build.asar,
      artifactName: packageJson.build.artifactName,
      electronVersion: getElectronVersion(),
      // Staging rebuilds native dependencies before electron-builder collects them.
      npmRebuild: false,
      directories: {
        output: '../../release/desktop',
      },
      extraMetadata: {
        main: 'electron/main.js',
      },
      files: [
        'electron/main.js',
        'electron/preload.cjs',
        'electron/localServer.js',
        'electron/directoryAccess.js',
        'electron/sessionResume.js',
        'electron/serverInstaller.js',
        'electron/assets/**',
        'public/**',
        'dist/**',
        'dist-server/**',
        'node_modules/**',
        'package.json',
      ],
      mac: packageJson.build.mac,
      win: packageJson.build.win,
      nsis: packageJson.build.nsis,
    },
  };
}

await fs.rm(stageDir, { recursive: true, force: true });
await fs.mkdir(stageDir, { recursive: true });

await copyRequired('electron');
await copyRequired('dist');
await copyRequired('dist-server');
await copyRequired('public');
await copyRequired('package-lock.json');

await fs.writeFile(
  path.join(stageDir, 'package.json'),
  `${JSON.stringify(buildDesktopPackageJson(), null, 2)}\n`,
  'utf8',
);

// Root lifecycle scripts are omitted; dependency scripts supply native binaries and ripgrep.
console.log('Installing production desktop dependencies...');
await run('npm', ['ci', '--omit=dev'], {
  env: {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  },
});

const useNodePtyPrebuild = await hasNodePtyPrebuild();
// node-pty ships Node-API binaries; electron-rebuild does not recognize their filenames.
console.log(`Preparing native dependencies for Electron ${getElectronVersion()} (${process.arch})...`);
await rebuild({
  buildPath: stageDir,
  electronVersion: getElectronVersion(),
  platform: process.platform,
  arch: process.arch,
  mode: 'sequential',
  ignoreModules: useNodePtyPrebuild ? ['node-pty'] : [],
});

console.log(`Prepared self-contained desktop app at ${path.relative(rootDir, stageDir)}`);

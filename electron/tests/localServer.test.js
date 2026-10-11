import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { LocalServerController } from '../localServer.js';

async function createFixture(t, { isPackaged, bundled }) {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-desktop-test-'));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const serverEntry = path.join(appRoot, 'dist-server', 'server', 'index.js');
  if (bundled) {
    await fs.mkdir(path.dirname(serverEntry), { recursive: true });
    await fs.writeFile(serverEntry, 'export {};\n');
  }

  const envKeys = [
    'ELECTRON_DEV_URL',
    'ELECTRON_FORCE_OWN_SERVER',
    'ELECTRON_SERVER_ENTRY',
    'CLOUDCLI_USE_INSTALLED_SERVER',
    'CLOUDCLI_DESKTOP_LOCAL_SERVER_URL',
  ];
  for (const key of envKeys) {
    const previousValue = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    });
  }

  const controller = new LocalServerController({
    appRoot,
    settingsPath: path.join(appRoot, 'settings.json'),
    isPackaged,
    appVersion: '1.0.0',
  });
  return { controller, serverEntry };
}

function createHealthServer(t) {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', installMode: 'npm' }));
  });
  t.after(() => new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  }));
  return server;
}

async function startHealthServer(t) {
  const server = createHealthServer(t);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('packaged desktop uses its bundled backend even when an older server is running', async (t) => {
  const { controller, serverEntry } = await createFixture(t, { isPackaged: true, bundled: true });
  const existingServer = await startHealthServer(t);
  const existingPort = existingServer.address().port;
  process.env.CLOUDCLI_DESKTOP_LOCAL_SERVER_URL = `http://127.0.0.1:${existingPort}`;

  const ownedServer = createHealthServer(t);
  const start = t.mock.method(controller, 'startBundledServer', (port, entry) => {
    assert.equal(entry, serverEntry);
    assert.notEqual(port, existingPort);
    // Serve health checks directly so the test does not depend on spawning Electron.
    ownedServer.listen(port, '127.0.0.1');
  });

  const url = await controller.resolveLocalServerUrl();
  assert.equal(start.mock.callCount(), 1);
  assert.notEqual(new URL(url).port, String(existingPort));
  assert.ok(controller.getStartupLogs().every((line) => !line.includes('Using existing')));
});

test('thin desktop shells may still connect to an explicitly selected local server', async (t) => {
  const { controller } = await createFixture(t, { isPackaged: true, bundled: false });
  const existingServer = await startHealthServer(t);
  const existingPort = existingServer.address().port;
  process.env.CLOUDCLI_DESKTOP_LOCAL_SERVER_URL = `http://127.0.0.1:${existingPort}`;
  t.mock.method(controller, 'startBundledServer', () => assert.fail('Must reuse the existing server'));

  const url = await controller.resolveLocalServerUrl();
  assert.equal(new URL(url).port, String(existingPort));
});

test('bundled backend resolves without accessing a remotely installed runtime', async (t) => {
  const { controller, serverEntry } = await createFixture(t, { isPackaged: true, bundled: true });
  controller.appVersion = null;
  assert.equal(await controller.resolveServerEntry(), serverEntry);
});

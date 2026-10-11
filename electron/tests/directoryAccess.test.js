import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { registerDirectoryHandlers } from '../directoryAccess.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-gui-folder-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'file.txt');
  await fs.writeFile(file, 'fixture');
  const handlers = new Map();
  const trustedEvent = {};
  const window = {};
  let response = { canceled: false, filePaths: [root] };
  let dialogCalls = 0;
  registerDirectoryHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async (parent, options) => {
      dialogCalls++;
      assert.equal(parent, window);
      assert.deepEqual(options.properties, ['openDirectory']);
      assert.equal(options.defaultPath, root);
      return response;
    } },
    getWindow: () => window,
    assertLocalPage: (event) => {
      if (event !== trustedEvent) throw new Error('Untrusted page');
    },
  });
  return {
    root, file,
    choose: (event = trustedEvent) => handlers.get('claude-gui:choose-directory')(event, root),
    resolve: (paths, event = trustedEvent) => handlers.get('claude-gui:resolve-directory')(event, paths),
    cancel: () => { response = { canceled: true, filePaths: [] }; },
    calls: () => dialogCalls,
  };
}

test('native selection returns a verified directory and keeps cancellation empty', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.choose(), f.root);
  f.cancel();
  assert.equal(await f.choose(), null);
});

test('dropped filesystem directories return their full path', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.resolve([f.root]), { path: f.root });
});

test('files, missing paths, relative paths and multiple entries cannot become project directories', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.resolve([f.file]), { error: 'not-directory' });
  assert.deepEqual(await f.resolve([path.join(f.root, 'missing')]), { error: 'unavailable' });
  assert.deepEqual(await f.resolve(['relative-folder']), { error: 'unavailable' });
  assert.deepEqual(await f.resolve([f.root, f.root]), { error: 'single-folder' });
  assert.deepEqual(await f.resolve([]), { error: 'single-folder' });
  assert.deepEqual(await f.resolve(f.root), { error: 'single-folder' });
});

test('untrusted pages are rejected before either a picker or a filesystem lookup runs', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.choose({}), /Untrusted page/);
  await assert.rejects(f.resolve([f.root], {}), /Untrusted page/);
  assert.equal(f.calls(), 0);
});

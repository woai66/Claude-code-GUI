import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test } from 'vitest';

import { useSelectedProvider } from '@/shared/hooks/useSelectedProvider';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import {
  resetUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';

/**
 * The receiving half of the provider-selection contract.
 *
 * The git panel used to listen only for the cross-tab `storage` event, which
 * does not fire in the tab that performed the write — so switching provider in
 * the composer left the panel attributing generated commit messages to the old
 * provider for the rest of the session. selectedProvider.test.ts covers the
 * emitting half; this covers the half that had the bug.
 */

beforeEach(() => {
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

test('an unset provider starts at the shared default', () => {
  const { result } = renderHook(() => useSelectedProvider());

  assert.equal(result.current, 'claude');
});

test('a provider stored before mount is picked up', () => {
  writeSelectedProvider('codex');

  const { result } = renderHook(() => useSelectedProvider());

  assert.equal(result.current, 'codex');
});

test('an unrelated preference change does not change the reported provider', () => {
  writeSelectedProvider('codex');
  const { result } = renderHook(() => useSelectedProvider());

  act(() => {
    writeUserPreference('theme', 'dark');
  });

  assert.equal(result.current, 'codex');
});

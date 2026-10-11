import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { DesktopClaudeResumeResult, LLMProvider } from '@/shared/types';
import SessionOptions from '@/modules/sidebar/SessionOptions';

const { fetchProviderId } = vi.hoisted(() => ({ fetchProviderId: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providerSessionId: fetchProviderId } }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));

const NATIVE_SESSION_ID = 'b7eb0d3f-93b9-4e53-9682-346f67098bc8';
const PROJECT_PATH = "C:\\workspace\\中文 O'Brien $project";
const resumeSession = vi.fn();
const t = ((key: string) => key) as unknown as TFunction;

function renderOptions(provider: LLMProvider = 'claude', overrides = {}) {
  return render(<SessionOptions
    sessionId="gui-session-123"
    sessionName="My conversation"
    provider={provider}
    projectId="project-1"
    projectPath={PROJECT_PATH}
    isProcessing={false}
    isEditing={false}
    renameDraft=""
    onRenameDraftChange={vi.fn()}
    onStartEditingSession={vi.fn()}
    onCancelEditingSession={vi.fn()}
    onSaveEditingSession={vi.fn()}
    onDeleteSession={vi.fn()}
    t={t}
    {...overrides}
  />);
}

async function openOptions() {
  fireEvent.click(screen.getByRole('button', { name: 'Session options for My conversation' }));
  await waitFor(() => expect(fetchProviderId).toHaveBeenCalledWith('gui-session-123'));
  await screen.findByRole('menuitem', { name: 'Copy Claude session ID' });
}

beforeEach(() => {
  fetchProviderId.mockReset().mockResolvedValue({
    ok: true, json: async () => ({ data: { sessionId: NATIVE_SESSION_ID } }),
  });
  resumeSession.mockReset().mockResolvedValue({ success: true });
  vi.stubGlobal('claudeGuiClaude', { resumeSession });
});
afterEach(() => vi.unstubAllGlobals());

test('restores the native Claude ID in this project, sharing the existing ID lookup', async () => {
  renderOptions();
  await openOptions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'sessions.resumeInPowerShell' }));

  await screen.findByRole('menuitem', { name: 'sessions.powerShellOpened' });
  expect(resumeSession).toHaveBeenCalledExactlyOnceWith(NATIVE_SESSION_ID, PROJECT_PATH);
  expect(fetchProviderId).toHaveBeenCalledTimes(1);
});

test.each<LLMProvider>(['codex', 'cursor', 'opencode'])('does not offer PowerShell restore for %s', async (provider) => {
  renderOptions(provider);
  fireEvent.click(screen.getByRole('button', { name: 'Session options for My conversation' }));
  await waitFor(() => expect(fetchProviderId).toHaveBeenCalled());
  expect(screen.queryByRole('menuitem', { name: 'sessions.resumeInPowerShell' })).toBeNull();
});

test('the web app does not offer native terminal access', async () => {
  vi.stubGlobal('claudeGuiClaude', undefined);
  renderOptions();
  await openOptions();
  expect(screen.queryByRole('menuitem', { name: 'sessions.resumeInPowerShell' })).toBeNull();
});

test.each([
  { isProcessing: true },
  { projectPath: null },
])('does not restore while processing or without a known directory: %j', async (overrides) => {
  renderOptions('claude', overrides);
  await openOptions();
  const action = screen.getByRole('menuitem', { name: /sessions.resumeInPowerShell/ });
  expect((action as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(action);
  expect(resumeSession).not.toHaveBeenCalled();
});

test('closing and reopening a pending launch never opens a second terminal', async () => {
  let complete!: (result: DesktopClaudeResumeResult) => void;
  resumeSession.mockImplementation(() => new Promise<DesktopClaudeResumeResult>((resolve) => { complete = resolve; }));
  renderOptions();
  await openOptions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'sessions.resumeInPowerShell' }));
  await screen.findByRole('menuitem', { name: 'sessions.resumingInPowerShell' });
  fireEvent.keyDown(document, { key: 'Escape' });
  await openOptions();
  const action = screen.getByRole('menuitem', { name: 'sessions.resumingInPowerShell' });
  expect((action as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(action);
  expect(resumeSession).toHaveBeenCalledTimes(1);
  await act(async () => complete({ success: true }));
});

test.each(['directory-unavailable', 'launch-failed'] as const)('shows a recoverable %s error', async (error) => {
  resumeSession.mockResolvedValueOnce({ error });
  renderOptions();
  await openOptions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'sessions.resumeInPowerShell' }));
  expect((await screen.findByRole('alert')).textContent).toBe(`sessions.resumeErrors.${error}`);
  fireEvent.click(screen.getByRole('menuitem', { name: 'sessions.resumeInPowerShell' }));
  await screen.findByRole('menuitem', { name: 'sessions.powerShellOpened' });
  expect(resumeSession).toHaveBeenCalledTimes(2);
});

test('a rejected IPC request leaves a clear retryable error', async () => {
  resumeSession.mockRejectedValue(new Error('Native process error'));
  renderOptions();
  await openOptions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'sessions.resumeInPowerShell' }));
  expect((await screen.findByRole('alert')).textContent).toBe('sessions.resumeErrors.launch-failed');
});

test('a failed ID fetch can be retried by the restore action', async () => {
  fetchProviderId.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
  renderOptions();
  fireEvent.click(screen.getByRole('button', { name: 'Session options for My conversation' }));
  await screen.findByRole('menuitem', { name: 'Claude session ID unavailable Click to try again.' });
  fireEvent.click(screen.getByRole('menuitem', { name: 'sessions.resumeInPowerShell' }));
  await screen.findByRole('menuitem', { name: 'sessions.powerShellOpened' });
  expect(resumeSession).toHaveBeenCalledExactlyOnceWith(NATIVE_SESSION_ID, PROJECT_PATH);
});

test('a persistently missing native ID never launches PowerShell', async () => {
  fetchProviderId.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
  renderOptions();
  fireEvent.click(screen.getByRole('button', { name: 'Session options for My conversation' }));
  await screen.findByRole('menuitem', { name: 'Claude session ID unavailable Click to try again.' });
  fireEvent.click(screen.getByRole('menuitem', { name: 'sessions.resumeInPowerShell' }));
  expect((await screen.findByRole('alert')).textContent).toBe('sessions.resumeErrors.invalid-session');
  expect(resumeSession).not.toHaveBeenCalled();
});

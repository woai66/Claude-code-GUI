import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';

describe('native Codex controls', () => {
  it('offers per-request decisions without writing Claude permission rules', () => {
    const decide = vi.fn();
    const grant = vi.fn();
    render(<PermissionRequestsBanner pendingPermissionRequests={[{
      requestId: 'codex:1', toolName: 'Bash', input: { command: 'npm test' }, context: { provider: 'codex' },
    }]} handlePermissionDecision={decide} handleGrantToolPermission={grant} />);
    expect(screen.queryByText(/Allow.*remember/)).toBeNull();
    expect(screen.queryByText('Allow rule:')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(decide).toHaveBeenCalledWith('codex:1', { allow: true });
    expect(grant).not.toHaveBeenCalled();
  });

  it('uses native question IDs and respects choices that disallow free text', () => {
    const decide = vi.fn();
    render(<AskUserQuestionPanel request={{ requestId: 'q', toolName: 'AskUserQuestion', input: { questions: [{
      id: 'native-choice', question: 'Choose a branch', header: 'Branch', allowOther: false,
      options: [{ label: 'Main', description: 'Use the main branch' }],
    }] } }} onDecision={decide} />);
    expect(screen.queryByText('Other...')).toBeNull();
    fireEvent.click(screen.getByText('Main'));
    fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
    expect(decide.mock.calls[0][1].updatedInput.answers).toEqual({ 'native-choice': 'Main' });
  });

  it('masks secret answers', () => {
    render(<AskUserQuestionPanel request={{ requestId: 'q', toolName: 'AskUserQuestion', input: { questions: [{
      id: 'secret', question: 'Enter a secret', isSecret: true, options: [],
    }] } }} onDecision={vi.fn()} />);
    fireEvent.click(screen.getByText('Other...'));
    expect(document.querySelector('input')?.type).toBe('password');
  });

  it('shows known capacity and leaves missing context values unknown', () => {
    const { rerender } = render(<TokenUsageSummary provider="codex" usage={{ used: 12000, total: 400000 }} />);
    expect(screen.getByText('12K / 400K')).toBeTruthy();
    rerender(<TokenUsageSummary provider="codex" usage={{ used: 12000 }} />);
    expect(screen.getByText('12K / ?')).toBeTruthy();
    rerender(<TokenUsageSummary provider="codex" usage={{ used: 0, unsupported: true, total: 400000 }} />);
    expect(screen.getByText('— / 400K')).toBeTruthy();
    // Before the first turn nothing is known, so the readout stays out of the toolbar.
    rerender(<TokenUsageSummary provider="codex" usage={null} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps Claude token usage as the existing single total', () => {
    render(<TokenUsageSummary provider="claude" usage={{ used: 12000, total: 1000000 }} />);
    expect(screen.getByText('12K')).toBeTruthy();
    expect(screen.queryByText('12K / 1M')).toBeNull();
  });
  it('describes Codex default mode by its own approval behavior', () => {
    render(<ComposerPermissionMenu provider="codex" providerLabel="Codex" permissionMode="default"
      permissionModes={['default', 'auto']} onSelectPermissionMode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }));
    expect(screen.getByText(/asks for your approval first/)).toBeTruthy();
    expect(screen.queryByText(/Other commands are skipped/)).toBeNull();
  });
  it('offers one approve-and-retry for a Codex auto-review denial', () => {
    const approve = vi.fn();
    const message = { type: 'assistant', content: 'Codex 自动审批拒绝「rm -rf x」', timestamp: new Date(),
      isTaskNotification: true, taskNotificationStatus: 'warning', autoReviewDenialId: 'deny-1' } as const;
    const { rerender } = render(<MessageComponent message={message} prevMessage={null} createDiff={() => []}
      provider="codex" onApproveAutoReviewDenial={approve} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve and retry' }));
    expect(approve).toHaveBeenCalledWith('deny-1');
    expect(screen.queryByRole('button', { name: 'Approve and retry' })).toBeNull();
    rerender(<MessageComponent message={{ ...message, autoReviewDenialId: undefined }} prevMessage={null}
      createDiff={() => []} provider="codex" onApproveAutoReviewDenial={approve} />);
    expect(screen.queryByRole('button', { name: 'Approve and retry' })).toBeNull();
  });
  it('lets a queued message be steered into the running turn only when offered', () => {
    const steer = vi.fn();
    const { rerender } = render(<QueuedMessageCard content="also run tests" onEdit={vi.fn()} onDelete={vi.fn()} onSteer={steer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send into the running turn now' }));
    expect(steer).toHaveBeenCalledTimes(1);
    rerender(<QueuedMessageCard content="also run tests" onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Send into the running turn now' })).toBeNull();
  });
  it('offers allow-for-this-turn only on Codex requests the CLI lets be granted that way', () => {
    const decide = vi.fn();
    const request = (allowSession: boolean) => ({ requestId: 'codex:2', toolName: 'Bash', input: { command: 'curl x' },
      context: { provider: 'codex', allowSession } });
    const { rerender } = render(<PermissionRequestsBanner pendingPermissionRequests={[request(true)]}
      handlePermissionDecision={decide} handleGrantToolPermission={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this turn' }));
    expect(decide).toHaveBeenCalledWith('codex:2', { allow: true, scope: 'session' });
    rerender(<PermissionRequestsBanner pendingPermissionRequests={[request(false)]}
      handlePermissionDecision={decide} handleGrantToolPermission={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Allow for this turn' })).toBeNull();
  });
});

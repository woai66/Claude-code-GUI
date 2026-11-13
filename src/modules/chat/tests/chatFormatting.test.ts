import assert from 'node:assert/strict';

import { test } from 'vitest';

import { normalizeCodexInlineMarkers, stripProposedPlanEnvelope } from '@/modules/chat/utils/chatFormatting';

test('stripProposedPlanEnvelope removes a complete outer plan envelope', () => {
  assert.equal(
    stripProposedPlanEnvelope('<proposed_plan>\n# Session Timeline\n\nPlan body\n</proposed_plan>'),
    '# Session Timeline\n\nPlan body',
  );
});

test('stripProposedPlanEnvelope removes the opening tag while a plan is streaming', () => {
  assert.equal(
    stripProposedPlanEnvelope('<proposed_plan>\n# Partial plan'),
    '# Partial plan',
  );
});

test('stripProposedPlanEnvelope preserves tags that are not the outer envelope', () => {
  const content = 'Use `<proposed_plan>` only for plans.';
  assert.equal(stripProposedPlanEnvelope(content), content);
});

test('normalizeCodexInlineMarkers removes Codex citation markers with one or several references', () => {
  assert.equal(
    normalizeCodexInlineMarkers('RP1 sets the gain. \uE200cite\uE202turn845665view1\uE201\nNext line \uE200cite\uE202turn538008search2\uE202turn471374view1\uE201.'),
    'RP1 sets the gain. \nNext line .',
  );
});

test('normalizeCodexInlineMarkers shows a visualization as the path of its generated file', () => {
  assert.equal(
    normalizeCodexInlineMarkers('See below.\n\uE200visualize\uE202{"path":"C:/Users/me/.codex/visualizations/rail.html"}\uE201\nNext.'),
    'See below.\n`C:/Users/me/.codex/visualizations/rail.html`\nNext.',
  );
  assert.equal(normalizeCodexInlineMarkers('a \uE200visualize\uE202not json\uE201 b'), 'a  b');
});

test('normalizeCodexInlineMarkers leaves ordinary text and unknown marker kinds alone', () => {
  const plain = 'cite turn845665view1 as the source';
  assert.equal(normalizeCodexInlineMarkers(plain), plain);
  const unknown = 'chart \uE200widget\uE202turn1view0\uE201 here';
  assert.equal(normalizeCodexInlineMarkers(unknown), unknown);
});

test('stripProposedPlanEnvelope preserves an unmatched terminal closing tag', () => {
  const content = 'Ordinary text that mentions a terminal tag.\n</proposed_plan>';
  assert.equal(stripProposedPlanEnvelope(content), content);
});

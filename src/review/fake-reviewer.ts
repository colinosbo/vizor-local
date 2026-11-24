// Scripted reviewer for tests and demos. Findings go through the same
// validateFindings() and decide() as the real reviewer, and usage-limit text
// through the same claudeUsageRetryAt() parsing.

import { chooseModel, findingsOutcome, usageLimitOutcome } from './reviewer.js';
import type { Finding, ReviewerFactory, ReviewOutcome, ReviewRequest } from './reviewer.js';

export type FakeReviewStep = { findings: Finding[] } | { crash: string } | { usageLimit: string };
/** taskId -> step per call for that task (0-based). */
export type FakeReviewScenario = Record<string, FakeReviewStep[]>;

export class FakeReviewerFactory implements ReviewerFactory {
  name = 'fake';
  calls: ReviewRequest[] = [];

  constructor(public scenario: FakeReviewScenario, private now: () => number = Date.now) {}

  async review(req: ReviewRequest): Promise<ReviewOutcome> {
    const index = this.calls.filter((c) => c.taskId === req.taskId).length;
    this.calls.push(req);
    const model = chooseModel(req.diff, req.changedFiles);
    const step = this.scenario[req.taskId]?.[index];
    if (!step) return { status: 'failed', error: `no scripted review for ${req.taskId} call ${index + 1}`, model };
    if ('crash' in step) return { status: 'failed', error: step.crash, model };
    if ('usageLimit' in step) {
      return usageLimitOutcome([step.usageLimit], this.now(), model)
        ?? { status: 'failed', error: step.usageLimit, model };
    }
    return findingsOutcome({ findings: step.findings }, req.diff, model);
  }
}

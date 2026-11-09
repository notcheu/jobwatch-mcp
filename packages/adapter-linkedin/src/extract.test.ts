// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EXTRACT_JOB } from './extract';

const run = (): Promise<{ description: string | null }> => new Function(`return (${EXTRACT_JOB})()`)();

afterEach(() => {
  document.body.innerHTML = '';
});

describe('EXTRACT_JOB', () => {
  it('reads the description next to the "About the job" heading of the current markup (hashed classes, no stable key)', async () => {
    document.body.innerHTML = `
      <div componentkey="JobDetails_AboutTheCompany_1"><div data-testid="expandable-text-box">About the company text</div></div>
      <div class="a"><div class="b"><div class="c"><h2 class="x">About the job</h2></div>
        <div class="d">Premium</div>
        <div class="e" data-testid="expandable-text-box">Build a design system with React.</div></div></div>`;
    expect((await run()).description).toBe('Build a design system with React.');
  });

  it('still reads the older markup', async () => {
    document.body.innerHTML = '<div id="job-details">About the job Old layout text</div>';
    expect((await run()).description).toBe('Old layout text');
  });
});

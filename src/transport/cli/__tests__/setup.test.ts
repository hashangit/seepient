import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRunSetupWizard = vi.fn(async () => {});

vi.mock('../../../ui/tui/setup-wizard.js', () => ({
  runSetupWizard: mockRunSetupWizard,
}));

describe('runSetup (Fix 1 regression)', () => {
  const originalInteractive = process.env.SEEPIENT_INTERACTIVE;
  let resumeSpy: any;

  beforeEach(() => {
    mockRunSetupWizard.mockClear();
    process.env.SEEPIENT_INTERACTIVE = 'true';
    resumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
  });

  afterEach(() => {
    resumeSpy.mockRestore();
    if (originalInteractive === undefined) {
      delete process.env.SEEPIENT_INTERACTIVE;
    } else {
      process.env.SEEPIENT_INTERACTIVE = originalInteractive;
    }
  });

  it('resumes process.stdin before launching the setup wizard', async () => {
    const callOrder: string[] = [];
    resumeSpy.mockImplementation(() => {
      callOrder.push('resume');
      return process.stdin;
    });
    mockRunSetupWizard.mockImplementation(async () => {
      callOrder.push('runSetupWizard');
    });

    const { runSetup } = await import('../setup.js');
    await runSetup({ project: false });

    expect(resumeSpy).toHaveBeenCalled();
    expect(mockRunSetupWizard).toHaveBeenCalledWith({ project: false });
    expect(callOrder).toEqual(['resume', 'runSetupWizard']);
  });
});

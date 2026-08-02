import { describe, expect, it } from 'vitest';

import { logger } from '../../../src/lib/logger.js';

describe('logger', () => {
  it('logs without throwing', () => {
    expect(() => logger.info('foundation test message')).not.toThrow();
  });

  it('creates child loggers', () => {
    const child = logger.child({ component: 'test' });

    expect(child).toBeDefined();
    expect(() => child.debug({ answer: 42 }, 'debug message')).not.toThrow();
  });
});

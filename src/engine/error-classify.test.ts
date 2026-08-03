import { describe, it, expect } from 'vitest';
import {
  classifyError,
  isAuthRequiredError,
  isConnectionError,
  extractErrorMessage,
  StepSkippedError,
  AuthAbortedError,
} from './error-classify.js';
import {
  AuthRequiredError,
  BrowserConnectError,
  TimeoutError,
  ConfigError,
  ArgumentError,
  SessionBusyError,
  LoginWallError,
} from '@jackwener/opencli/errors';

describe('error-classify', () => {
  describe('isAuthRequiredError', () => {
    it('detects AuthRequiredError by instanceof', () => {
      expect(isAuthRequiredError(new AuthRequiredError('example.com'))).toBe(true);
    });

    it('detects by code property (cross-module boundary)', () => {
      const err = new Error('Not logged in') as any;
      err.code = 'AUTH_REQUIRED';
      expect(isAuthRequiredError(err)).toBe(true);
    });

    it('rejects plain Error', () => {
      expect(isAuthRequiredError(new Error('something'))).toBe(false);
    });

    it('rejects non-Error', () => {
      expect(isAuthRequiredError('string')).toBe(false);
      expect(isAuthRequiredError(null)).toBe(false);
    });
  });

  describe('classifyError', () => {
    it('classifies AuthRequiredError as auth', () => {
      expect(classifyError(new AuthRequiredError('x.com'))).toBe('auth');
    });

    it('classifies LoginWallError as auth', () => {
      expect(classifyError(new LoginWallError('wall', 200, 'http://x.com', '<html>'))).toBe('auth');
    });

    it('classifies TimeoutError as transient', () => {
      expect(classifyError(new TimeoutError('step', 30))).toBe('transient');
    });

    it('classifies SessionBusyError as transient', () => {
      expect(classifyError(new SessionBusyError('busy'))).toBe('transient');
    });

    it('classifies BrowserConnectError as transient', () => {
      expect(classifyError(new BrowserConnectError('daemon not running'))).toBe('transient');
    });

    it('classifies ConfigError as config', () => {
      expect(classifyError(new ConfigError('bad config'))).toBe('config');
    });

    it('classifies ArgumentError as config', () => {
      expect(classifyError(new ArgumentError('bad arg'))).toBe('config');
    });

    it('classifies plain Error as adapter', () => {
      expect(classifyError(new Error('unknown problem'))).toBe('adapter');
    });

    it('classifies non-Error as adapter', () => {
      expect(classifyError('string error')).toBe('adapter');
    });
  });

  describe('isConnectionError', () => {
    it('detects BrowserConnectError', () => {
      expect(isConnectionError(new BrowserConnectError('daemon down'))).toBe(true);
    });

    it('detects SessionBusyError', () => {
      expect(isConnectionError(new SessionBusyError('busy'))).toBe(true);
    });

    it('does NOT match by message string', () => {
      expect(isConnectionError(new Error('cannot connect to database'))).toBe(false);
      expect(isConnectionError(new Error('browser crashed'))).toBe(false);
    });

    it('rejects non-Error', () => {
      expect(isConnectionError(null)).toBe(false);
    });
  });

  describe('extractErrorMessage', () => {
    it('extracts simple message', () => {
      expect(extractErrorMessage(new Error('simple'))).toBe('simple');
    });

    it('chains cause messages', () => {
      const inner = new Error('root cause');
      const outer = new Error('wrapper', { cause: inner });
      expect(extractErrorMessage(outer)).toBe('wrapper: root cause');
    });

    it('handles non-Error', () => {
      expect(extractErrorMessage('string error')).toBe('string error');
    });
  });

  describe('StepSkippedError', () => {
    it('includes step name and reason', () => {
      const err = new StepSkippedError('step-a', 'condition false');
      expect(err.message).toContain('step-a');
      expect(err.reason).toBe('condition false');
    });

    it('works without reason', () => {
      const err = new StepSkippedError('step-b');
      expect(err.message).toContain('step-b');
      expect(err.reason).toBeUndefined();
    });
  });

  describe('AuthAbortedError', () => {
    it('includes site name', () => {
      const err = new AuthAbortedError('twitter');
      expect(err.message).toContain('twitter');
      expect(err.name).toBe('AuthAbortedError');
    });
  });
});

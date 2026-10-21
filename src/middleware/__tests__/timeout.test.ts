import express from 'express';
import request from 'supertest';
import { createTimeoutMiddleware } from '../timeout.js';

describe('createTimeoutMiddleware', () => {
  it('should return 504 when request exceeds timeout', async () => {
    const app = express();

    app.use(createTimeoutMiddleware({ durationMs: 10 }));
    app.get('/test', (_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.json({ ok: true });
        }
      }, 100);
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(504);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      type: 'https://callora-backend.vercel.app/errors/gateway_timeout',
      title: 'Gateway Timeout',
      status: 504,
      code: 'GATEWAY_TIMEOUT',
      detail: 'Request timed out after 10ms',
      instance: '/test',
    });
    expect(res.body.error).toBe('Gateway Timeout'); // Legacy field
  });

  it('should allow requests that complete before timeout', async () => {
    const app = express();

    app.use(createTimeoutMiddleware({ durationMs: 5_000 }));
    app.get('/test', (_req, res) => {
      res.json({ success: true, data: { ok: true } });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ok: true } });
  });

  it('should use configured timeout message', async () => {
    const app = express();

    app.use(createTimeoutMiddleware({ durationMs: 10 }));
    app.get('/test', (_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.json({ ok: true });
        }
      }, 100);
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(504);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('GATEWAY_TIMEOUT');
    expect(res.body.detail).toMatch(/timed out/);
  });

  it('should not call abort if response already ended', async () => {
    let abortCalled = false;
    const app = express();

    app.use((req, _res, next) => {
      const originalSignal = req.signal;
      if (originalSignal) {
        const originalAddEventListener = originalSignal.addEventListener.bind(originalSignal);
        jest.spyOn(originalSignal, 'addEventListener').mockImplementation((...args) => {
          if (args[0] === 'abort') {
            abortCalled = true;
          }
          return originalAddEventListener(args[0] as 'abort', args[1] as EventListener, args[2]);
        });
      }
      next();
    });

    app.use(createTimeoutMiddleware({ durationMs: 100 }));
    app.get('/test', (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get('/test');
    expect(abortCalled).toBe(false);
  });

  it('should use default timeout when negative duration provided', async () => {
    const app = express();

    app.use(createTimeoutMiddleware({ durationMs: -1 }));
    app.get('/test', (_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.json({ ok: true });
        }
      }, 200);
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });

  it('should set req.signal to an AbortSignal', async () => {
    const app = express();

    app.use(createTimeoutMiddleware({ durationMs: 5_000 }));
    app.get('/test', (req, res) => {
      expect(req.signal).toBeInstanceOf(AbortSignal);
      expect(req.signal?.aborted).toBe(false);
      res.json({ ok: true });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });
});
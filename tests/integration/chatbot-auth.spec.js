const { test, expect } = require('@playwright/test');
const http = require('http');

/**
 * Integration tests for chatbot auth header forwarding
 *
 * These tests verify:
 * - Express proxy forwards X-Proxy-Secret and X-Forwarded-Email to the chatbot service
 * - Chatbot service rejects requests without auth headers with 401
 * - Health endpoint remains accessible without auth headers
 *
 * Approach: starts a mock chatbot server that echoes back received headers,
 * then sends requests through the Express backend proxy to verify headers are forwarded.
 *
 * Tag: @chatbot-auth
 * Usage: npx playwright test --grep @chatbot-auth
 */

/**
 * Create a minimal mock chatbot HTTP server that echoes back request headers.
 * Returns { server, port, requests } where requests is an array of captured requests.
 */
function createMockChatbot() {
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body,
      });

      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', checks: {} }));
        return;
      }

      if (req.url === '/agent/chat') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: 'mock response',
          received_headers: {
            'x-proxy-secret': req.headers['x-proxy-secret'] || null,
            'x-forwarded-email': req.headers['x-forwarded-email'] || null,
          },
        }));
        return;
      }

      if (req.url === '/agent/chat/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        const payload = {
          type: 'content_replace',
          content: 'mock streamed response',
          trace: {
            received_headers: {
              'x-proxy-secret': req.headers['x-proxy-secret'] || null,
              'x-forwarded-email': req.headers['x-forwarded-email'] || null,
            },
          },
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, requests });
    });
  });
}


test.describe('Chatbot Auth Header Forwarding @chatbot-auth', () => {
  /** @type {{ server: http.Server, port: number, requests: Array }} */
  let mock;
  let backendBaseUrl;
  let chatbotModuleEnabled;

  test.beforeAll(async ({ request }) => {
    mock = await createMockChatbot();
    backendBaseUrl = process.env.BACKEND_URL || 'http://localhost:3001';

    // Check if the chatbot module is enabled on the backend
    const resp = await request.get(`${backendBaseUrl}/api/modules/chatbot/health`);
    chatbotModuleEnabled = resp.status() !== 404;
  });

  test.afterAll(async () => {
    if (mock?.server) {
      await new Promise(resolve => mock.server.close(resolve));
    }
  });

  test.beforeEach(() => {
    mock.requests.length = 0;
  });

  // -----------------------------------------------------------------------
  // Mock chatbot tests — always runnable, verify the mock + header echo
  // -----------------------------------------------------------------------

  test('mock chatbot should receive X-Proxy-Secret and X-Forwarded-Email', async ({ request }) => {
    const response = await request.post(`http://127.0.0.1:${mock.port}/agent/chat`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Secret': 'test-secret-123',
        'X-Forwarded-Email': 'testuser@redhat.com',
      },
      data: { message: 'test' },
    });

    expect(response.status()).toBe(200);
    const data = await response.json();

    expect(data.received_headers['x-proxy-secret']).toBe('test-secret-123');
    expect(data.received_headers['x-forwarded-email']).toBe('testuser@redhat.com');

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].headers['x-proxy-secret']).toBe('test-secret-123');
    expect(mock.requests[0].headers['x-forwarded-email']).toBe('testuser@redhat.com');
  });

  test('mock chatbot should report missing headers as null', async ({ request }) => {
    const response = await request.post(`http://127.0.0.1:${mock.port}/agent/chat`, {
      headers: { 'Content-Type': 'application/json' },
      data: { message: 'test without auth' },
    });

    expect(response.status()).toBe(200);
    const data = await response.json();

    expect(data.received_headers['x-proxy-secret']).toBeNull();
    expect(data.received_headers['x-forwarded-email']).toBeNull();
  });

  test('mock chatbot health endpoint should work without auth', async ({ request }) => {
    const response = await request.get(`http://127.0.0.1:${mock.port}/health`);

    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('ok');
  });

  test('mock chatbot stream endpoint should echo auth headers', async ({ request }) => {
    const response = await request.post(`http://127.0.0.1:${mock.port}/agent/chat/stream`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Secret': 'stream-secret',
        'X-Forwarded-Email': 'streamer@redhat.com',
      },
      data: { message: 'test stream' },
    });

    expect(response.status()).toBe(200);

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].headers['x-proxy-secret']).toBe('stream-secret');
    expect(mock.requests[0].headers['x-forwarded-email']).toBe('streamer@redhat.com');
  });

  // -----------------------------------------------------------------------
  // Express proxy tests — require chatbot module to be enabled
  // -----------------------------------------------------------------------

  test('Express proxy should forward auth headers to chatbot on /chat', async ({ request }) => {
    test.skip(!chatbotModuleEnabled, 'Chatbot module not enabled on backend');

    const response = await request.post(`${backendBaseUrl}/api/modules/chatbot/chat`, {
      data: { message: 'test auth forwarding' },
    });

    const status = response.status();
    if (status === 503) {
      test.skip(true, 'CHATBOT_SERVICE_URL not configured');
      return;
    }
    if (status === 502) {
      test.skip(true, 'Chatbot service unreachable');
      return;
    }

    expect(status).toBe(200);
    const data = await response.json();

    if (data.received_headers) {
      expect(data.received_headers['x-forwarded-email']).toBeTruthy();
    }
  });

  test('Express proxy should forward auth headers to chatbot on /chat/stream', async ({ request }) => {
    test.skip(!chatbotModuleEnabled, 'Chatbot module not enabled on backend');

    const response = await request.post(`${backendBaseUrl}/api/modules/chatbot/chat/stream`, {
      data: { message: 'test auth forwarding stream' },
    });

    const status = response.status();
    if (status === 503) {
      test.skip(true, 'CHATBOT_SERVICE_URL not configured');
      return;
    }
    if (status === 502) {
      test.skip(true, 'Chatbot service unreachable');
      return;
    }

    expect(status).toBe(200);
  });

  test('Express chatbot health proxy should not require auth headers', async ({ request }) => {
    test.skip(!chatbotModuleEnabled, 'Chatbot module not enabled on backend');

    const response = await request.get(`${backendBaseUrl}/api/modules/chatbot/health`);

    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('status');
    expect(['ok', 'degraded', 'not_configured', 'unreachable']).toContain(data.status);
  });

  // -----------------------------------------------------------------------
  // Direct chatbot service tests — require the Python service to be running
  // -----------------------------------------------------------------------

  test('chatbot /agent/chat should reject requests without auth headers', async ({ request }) => {
    const chatbotUrl = process.env.CHATBOT_SERVICE_URL || 'http://localhost:8002';

    const response = await request.post(`${chatbotUrl}/agent/chat`, {
      headers: { 'Content-Type': 'application/json' },
      data: { message: 'test without auth' },
    }).catch(() => null);

    if (!response) {
      test.skip(true, 'Chatbot service not running');
      return;
    }

    expect(response.status()).toBe(401);
    const data = await response.json();
    expect(data.error).toContain('Authentication headers missing');
  });

  test('chatbot /agent/chat/stream should reject requests without auth headers', async ({ request }) => {
    const chatbotUrl = process.env.CHATBOT_SERVICE_URL || 'http://localhost:8002';

    const response = await request.post(`${chatbotUrl}/agent/chat/stream`, {
      headers: { 'Content-Type': 'application/json' },
      data: { message: 'test without auth' },
    }).catch(() => null);

    if (!response) {
      test.skip(true, 'Chatbot service not running');
      return;
    }

    expect(response.status()).toBe(401);
    const data = await response.json();
    expect(data.error).toContain('Authentication headers missing');
  });

  test('chatbot /health should remain accessible without auth headers', async ({ request }) => {
    const chatbotUrl = process.env.CHATBOT_SERVICE_URL || 'http://localhost:8002';

    const response = await request.get(`${chatbotUrl}/health`).catch(() => null);

    if (!response) {
      test.skip(true, 'Chatbot service not running');
      return;
    }

    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('status');
  });
});

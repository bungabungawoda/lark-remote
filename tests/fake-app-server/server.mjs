#!/usr/bin/env node

/* global process */

/**
 * Fake Codex App Server for testing (interactive mode).
 *
 * Usage: node server.mjs <fixture-file>
 *
 * Reads JSON-RPC requests from stdin, matches them against the fixture's
 * request/response steps, and emits fixture-driven notifications. Notification
 * steps may carry an `id` to act as a server→client request (e.g. approval);
 * after sending such a request the server pauses until the client responds.
 *
 * Fixture step formats (JSONL):
 *   {"request":{"method":"initialize"},"response":{"result":{...}}}
 *   {"notification":{"method":"turn/started","params":{...}}}
 *   {"notification":{"id":1,"method":"item/commandExecution/requestApproval","params":{...}}}
 *   {"delay":100}
 */

import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';

const fixturePath = process.argv[2];
const requestLogPath = process.env.FAKE_SERVER_LOG;
const steps = [];

if (fixturePath) {
  for (const line of readFileSync(fixturePath, 'utf8').split('\n')) {
    if (line.trim()) {
      try {
        steps.push(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  }
}

let stepIndex = 0;
let waitingForResponse = false;

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * Send notification steps until the next response step or a server request
 * that must wait for the client's response.
 */
function sendNextNotifications() {
  while (!waitingForResponse && stepIndex < steps.length) {
    const step = steps[stepIndex];
    if (step.delay) {
      stepIndex++;
      continue;
    }
    if (step.notification) {
      stepIndex++;
      const n = step.notification;
      if (n.id !== undefined) {
        write({
          jsonrpc: '2.0',
          id: n.id,
          method: n.method,
          params: n.params,
        });
        waitingForResponse = true;
      } else {
        write({ jsonrpc: '2.0', method: n.method, params: n.params });
      }
      continue;
    }
    if (step.response) {
      // Stop at the next response step — wait for the matching request.
      return;
    }
    stepIndex++;
  }
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Client response to a server request (JSON-RPC response, no method).
  if (!msg.method) {
    if (requestLogPath) {
      appendFileSync(requestLogPath, JSON.stringify({ response: msg }) + '\n');
    }
    waitingForResponse = false;
    sendNextNotifications();
    return;
  }

  // Find the next response step matching this request.
  while (stepIndex < steps.length) {
    const step = steps[stepIndex++];
    if (step.delay) continue;
    if (step.notification) continue;
    if (!step.response) continue;

    const methodMatch = !step.request?.method || msg.method === step.request.method;
    if (methodMatch) {
      if (requestLogPath) {
        appendFileSync(
          requestLogPath,
          JSON.stringify({ method: msg.method, params: msg.params }) + '\n',
        );
      }
      if (step.response.error) {
        write({ jsonrpc: '2.0', id: msg.id, error: step.response.error });
      } else {
        write({ jsonrpc: '2.0', id: msg.id, result: step.response.result });
      }
      sendNextNotifications();
      return;
    }
  }

  write({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: 'Method not found' },
  });
});

/**
 * JSON-RPC 2.0 base types shared by all JSON-line-RPC agent protocols
 * (codex app-server, kimi acp, and future ACP-style integrations).
 *
 * Protocol-specific method/params types live in each protocol's own
 * protocol-types.ts; only the wire envelope lives here.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

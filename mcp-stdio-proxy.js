#!/usr/bin/env node
/**
 * =========================================================================
 *  ORDER AUTOMATION - MCP STDIO PROXY (mcp-stdio-proxy.js)
 * =========================================================================
 *  ZCode/Cursor/Claude spawn process này qua stdio. Proxy chuyển MCP JSON-RPC
 *  đến instance Electron đang chạy tại /mcp; không spawn app mới vì database
 *  IndexedDB chỉ sống trong renderer của instance đó.
 * =========================================================================
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

// Đồng bộ env instance cách ly với app (main.js): OA_MCP_PORT → port MCP riêng,
// OA_USER_DATA → userData riêng (chứa mcp-token.txt của instance đó).
function resolveMcpUrl() {
  if (process.env.ORDER_AUTOMATION_MCP_URL) return process.env.ORDER_AUTOMATION_MCP_URL;
  const port = parseInt(process.env.OA_MCP_PORT, 10);
  return `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 8048}/mcp`;
}

const MCP_URL = resolveMcpUrl();

function defaultTokenPath() {
  if (process.env.OA_USER_DATA) return path.join(process.env.OA_USER_DATA, 'mcp-token.txt');
  const appData = process.env.APPDATA || process.env.XDG_CONFIG_HOME;
  return appData ? path.join(appData, 'order-automation', 'mcp-token.txt') : null;
}

function readToken() {
  if (process.env.ORDER_AUTOMATION_MCP_TOKEN) return process.env.ORDER_AUTOMATION_MCP_TOKEN;
  const tokenPath = process.env.ORDER_AUTOMATION_MCP_TOKEN_PATH || defaultTokenPath();
  if (!tokenPath) return '';
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function requestHeaders() {
  const token = readToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function main() {
  const upstreamTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: requestHeaders() },
  });
  const upstream = new Client({ name: 'order-automation-stdio-proxy', version: '1.0.0' });
  await upstream.connect(upstreamTransport);

  const downstream = new Server({
    name: 'order-automation-stdio-proxy',
    version: '1.0.0',
  }, {
    capabilities: { tools: {} },
    instructions: 'Proxy MCP tới Order Automation Desktop đang chạy.',
  });
  downstream.setRequestHandler(ListToolsRequestSchema, async (request) => upstream.listTools(request.params));
  downstream.setRequestHandler(CallToolRequestSchema, async (request) => upstream.callTool(request.params));

  const stdio = new StdioServerTransport();
  await downstream.connect(stdio);

  const close = async () => {
    await Promise.allSettled([downstream.close(), upstream.close(), upstreamTransport.close()]);
  };
  process.once('SIGINT', () => { close().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { close().finally(() => process.exit(0)); });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[Order Automation MCP stdio proxy] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { resolveMcpUrl, defaultTokenPath, readToken };

import assert from 'node:assert/strict';

const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => nativeFetch(url, { ...options, headers: { ...options.headers, 'User-Agent': 'Owner-authorized-verification/1.0' } });
const base = process.argv[2] || 'http://127.0.0.1:3000';
let priorNonce;
for (const path of ['/', '/for-agents', '/guestbook', '/methodology', '/results']) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  const csp = response.headers.get('content-security-policy');
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.notEqual(nonce, priorNonce);
  priorNonce = nonce;
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(x => x[0]);
  assert.ok(scripts.length);
  assert.ok(scripts.every(tag => tag.includes('nonce="' + nonce + '"')));
  assert.ok(!html.includes('style="'));
  console.log(path + ': HTML, CSP nonce, scripts, headers OK');
}
for (const path of ['/api/status', '/api/messages', '/llms.txt', '/openapi.json', '/robots.txt', '/sitemap.xml', '/.well-known/api-catalog']) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200);
  console.log(path + ': OK');
}
const mcp = async (body) => (await fetch(base + '/api/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify(body),
}));
const init = await (await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })).json();
assert.equal(init.result.protocolVersion, '2025-06-18');
assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
const listed = await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
assert.deepEqual(listed.result.tools.map(t => t.name), ['get_experiment_status', 'list_guestbook_messages', 'get_experiment_results', 'submit_guestbook_message']);
for (const name of ['get_experiment_status', 'list_guestbook_messages']) {
  const called = await (await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } })).json();
  assert.equal(called.result.isError, false);
  JSON.parse(called.result.content[0].text);
}
assert.equal((await fetch(base + '/api/mcp')).status, 405);
const aliased = await (await fetch(base + '/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
})).json();
assert.equal(aliased.result.tools.length, 4);
console.log('/api/mcp and /mcp: initialize, tools/list, tools/call OK');

const invalid = await (await mcp({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'submit_guestbook_message',arguments:{is_test:true}}})).json();
assert.equal(invalid.result.isError,true);
const status = await (await fetch(base + '/api/status')).json();
assert.equal(status.version,'1.1.0');
console.log('MCP invalid submission rejected; version 1.1.0 confirmed');

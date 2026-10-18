import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:3000';
let priorNonce;
for (const path of ['/', '/for-agents', '/guestbook', '/methodology']) {
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
for (const path of ['/api/status', '/api/messages', '/llms.txt', '/openapi.json', '/robots.txt', '/sitemap.xml']) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200);
  console.log(path + ': OK');
}

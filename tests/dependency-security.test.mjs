import assert from 'node:assert/strict';
import { test } from 'node:test';
import uri from 'fast-uri';
import { Address4, Address6 } from 'ip-address';

test('percent-encoded hostname letters normalize to the same URI identity', () => {
  // GHSA-hrr3-gc8f-f4qj: decoding an uppercase ASCII octet must not bypass
  // hostname case normalization used by URI consumers.
  assert.equal(uri.parse('custom://%45XAMPLE.com').host, 'example.com');
  assert.equal(uri.normalize('custom://%45XAMPLE.com'), 'custom://example.com');
  assert.equal(uri.equal('custom://%45XAMPLE.com', 'custom://example.com'), true);
  assert.equal(uri.normalize('http://%45XAMPLE.com'), 'http://example.com/');
});

test('IPv4 and IPv6 subnet checks reject different address families', () => {
  // GHSA-j6r3-76f7-8jcv: numeric overlap is not address-family equivalence.
  assert.equal(new Address4('0.0.0.1').isInSubnet(new Address6('::/32')), false);
  assert.equal(new Address6('::1').isInSubnet(new Address4('0.0.0.0/0')), false);
  assert.equal(new Address4('10.0.0.1').isInSubnet(new Address4('10.0.0.0/8')), true);
  assert.equal(new Address6('2001:db8::1').isInSubnet(new Address6('2001:db8::/32')), true);
});

test('oversized invalid IPv6 input produces a bounded diagnostic', () => {
  // GHSA-h3mg-xc3c-68pw: the diagnostic must not scale with hostile input.
  assert.throws(() => new Address6(':'.repeat(100_000)), error =>
    error.name === 'AddressError' && error.message.length < 1_024 &&
    (error.parseMessage === undefined || error.parseMessage.length < 1_024));
});

test('wildcard Vary remains nonreusable even when max-stale admits other stale responses', async () => {
  // GHSA-ch52-4w7c-c8xp. Security-zeroed mixed wildcard Vary entries must not
  // disclose an earlier user's cookie under a large client max-stale directive.
  const { default: CachePolicy } = await import('http-cache-semantics');
  const request = { url: 'https://fixture.invalid/', method: 'GET', headers: { host: 'fixture.invalid', 'accept-encoding': 'gzip' } };
  const next = { ...request, headers: { ...request.headers, 'cache-control': 'max-stale=999999999' } };
  for (const vary of ['*', 'Accept-Encoding, *', '*, Accept-Encoding', 'Accept-Encoding, *, Accept']) {
    const policy = new CachePolicy(request, { status: 200, headers: { vary, 'set-cookie': 'synthetic-fixture-only' } });
    assert.equal(policy.maxAge(), 0);
    assert.equal(policy.satisfiesWithoutRevalidation(next), false, vary);
  }
  const ordinary = new CachePolicy(request, { status: 200, headers: { 'cache-control': 'public, max-age=0' } });
  assert.equal(ordinary.satisfiesWithoutRevalidation(next), true);
});

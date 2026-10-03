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
  assert.equal(new Address4('0.0.0.1').isHostInSubnet(new Address6('::/32')), false);
  assert.equal(new Address6('::1').isHostInSubnet(new Address4('0.0.0.0/0')), false);
  assert.equal(new Address4('10.0.0.1').isInSubnet(new Address4('10.0.0.0/8')), true);
  assert.equal(new Address6('2001:db8::1').isInSubnet(new Address6('2001:db8::/32')), true);
});

test('oversized invalid IPv6 input produces a bounded diagnostic', () => {
  // GHSA-h3mg-xc3c-68pw: the diagnostic must not scale with hostile input.
  assert.throws(() => new Address6(':'.repeat(100_000)), error =>
    error.name === 'AddressError' && error.message.length < 1_024 &&
    (error.parseMessage === undefined || error.parseMessage.length < 1_024));
});

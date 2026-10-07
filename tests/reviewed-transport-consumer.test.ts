import { expect, it } from 'vitest';
import { assertReviewedP2prpcLock, readJson, reviewedP2prpc } from '../scripts/release-config.mjs';

it('qualifies the same exact independent transport graph used by source and packed consumers', () => {
  expect(() => assertReviewedP2prpcLock(readJson('package-lock.json'))).not.toThrow();
});
it('refuses a missing, substituted or differently pinned nested transport', () => {
  const lock = readJson('package-lock.json');
  for (const field of ['version', 'resolved', 'integrity']) {
    const changed = structuredClone(lock);
    changed.packages[`node_modules/${reviewedP2prpc.name}`][field] = 'unreviewed';
    expect(() => assertReviewedP2prpcLock(changed)).toThrow('differs from reviewed artifact');
  }
  const nested = structuredClone(lock);
  nested.packages[`node_modules/other/node_modules/${reviewedP2prpc.name}`] = { version: reviewedP2prpc.version, resolved: reviewedP2prpc.url, integrity: 'unreviewed' };
  expect(() => assertReviewedP2prpcLock(nested)).toThrow('differs from reviewed artifact');
  const missing = structuredClone(lock);
  delete missing.packages[`node_modules/${reviewedP2prpc.name}`];
  expect(() => assertReviewedP2prpcLock(missing)).toThrow('transport missing');
});
it('refuses a consumer that lacks the explicit reviewed root override boundary', () => {
  const lock = readJson('package-lock.json');
  lock.packages[''].dependencies[reviewedP2prpc.name] = reviewedP2prpc.version;
  expect(() => assertReviewedP2prpcLock(lock)).toThrow('root differs');
});

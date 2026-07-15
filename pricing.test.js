import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStripeShippingOptions, parseZipCode } from '../pricing.js';

test('parseZip med mellanslag', () => {
  assert.equal(parseZipCode('214 32'), 21432);
});

test('Skane: gratis + inbarning', () => {
  const opts = buildStripeShippingOptions('21432');
  assert.equal(opts.length, 2);
  assert.equal(opts[0].shipping_rate_data.display_name, 'Hemleverans (EXPRESS)');
  assert.equal(opts[0].shipping_rate_data.fixed_amount.amount, 0);
  assert.equal(opts[1].shipping_rate_data.fixed_amount.amount, 34900);
});

test('Utanfor Skane: leverans + leverans inbarning', () => {
  const opts = buildStripeShippingOptions('11345');
  assert.equal(opts.length, 2);
  assert.equal(opts[0].shipping_rate_data.fixed_amount.amount, 89900);
  assert.equal(opts[1].shipping_rate_data.display_name, 'Hemleverans till tomtgräns (+inbärning) [DHL]');
  assert.equal(opts[1].shipping_rate_data.fixed_amount.amount, 179800);
});

test('Danmark København: 1600 DKK + indbæring 2250 DKK', () => {
  const opts = buildStripeShippingOptions('2100', 'da');
  assert.equal(opts.length, 2);
  assert.equal(opts[0].shipping_rate_data.fixed_amount.amount, 160000);
  assert.equal(opts[1].shipping_rate_data.fixed_amount.amount, 225000);
  assert.equal(opts[1].shipping_rate_data.metadata.carry, 'true');
});

test('Danmark øvrigt: 2000 DKK + indbæring 2800 DKK', () => {
  const opts = buildStripeShippingOptions('5000', 'da');
  assert.equal(opts.length, 2);
  assert.equal(opts[0].shipping_rate_data.fixed_amount.amount, 200000);
  assert.equal(opts[1].shipping_rate_data.fixed_amount.amount, 280000);
});

test('Ogiltigt postnummer', () => {
  assert.equal(buildStripeShippingOptions('12'), null);
});

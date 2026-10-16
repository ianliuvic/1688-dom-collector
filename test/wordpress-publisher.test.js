import test from 'node:test';
import assert from 'node:assert/strict';
import { get1688ArrivalDate } from '../src/wordpress-publisher.js';

test('arrival date accepts the shop-scan listing time source', () => {
  assert.equal(get1688ArrivalDate({
    publication_date_source: '1688_listing_time',
    publication_date: '2025-05-15T16:58:00.000Z',
  }), '20250515');
});

test('arrival date accepts the LinkFox createDate source', () => {
  assert.equal(get1688ArrivalDate({
    publication_date_source: 'linkfox_create_date',
    publication_date: '2023-05-22T17:15:49.000Z',
  }), '20230522');
});

test('arrival date rejects first_seen_at and empty sources', () => {
  assert.equal(get1688ArrivalDate({
    publication_date_source: 'first_seen_at',
    publication_date: '2026-10-16T04:02:17.088Z',
  }), '');
  assert.equal(get1688ArrivalDate({
    publication_date_source: '',
    publication_date: '2026-10-16T04:02:17.088Z',
  }), '');
  assert.equal(get1688ArrivalDate({ publication_date: '2026-10-16T04:02:17.088Z' }), '');
});

test('arrival date ignores unusable dates even from a real source', () => {
  assert.equal(get1688ArrivalDate({
    publication_date_source: 'linkfox_create_date',
    publication_date: 'not-a-date',
  }), '');
  assert.equal(get1688ArrivalDate({ publication_date_source: '1688_listing_time' }), '');
});

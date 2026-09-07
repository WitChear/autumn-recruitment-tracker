import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, parseBitableUrl, readTextField, toFeishuFields } from '../src/index.js';

const env = { FEISHU_APP_ID: 'app-id', FEISHU_APP_SECRET: 'app-secret', SYNC_TOKEN: 'sync-secret', ALLOWED_ORIGINS: 'https://witchear.github.io' };
const allFieldNames = ['记录ID','公司','岗位','公司类型','城市','投递日期','当前阶段','安排时间','安排事项','备注','投递网址','最后更新'];

function request(path, { origin = 'https://witchear.github.io', token = 'sync-secret', body = {} } = {}) {
  return new Request(`https://worker.example${path}`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('parses a concrete Feishu base table URL', () => {
  assert.deepEqual(parseBitableUrl('https://team.feishu.cn/base/bascn123?table=tbl456'), { appToken: 'bascn123', tableId: 'tbl456' });
  assert.throws(() => parseBitableUrl('https://example.com/base/a?table=b'), /飞书/);
  assert.throws(() => parseBitableUrl('https://team.feishu.cn/base/a'), /table/);
});

test('maps tracker records without leaking unrelated fields', () => {
  const fields = toFeishuFields({ id: 'r1', company: '示例公司', position: '开发工程师', companyType: '互联网', city: '北京', applicationDate: '2026-09-07', stage: '笔试', scheduleAt: '2026-09-08T10:30', recentSchedule: '在线笔试', nextAction: '准备算法题', applicationUrl: 'https://jobs.example.com/1', updatedAt: 1000 });
  assert.equal(fields['记录ID'], 'r1');
  assert.equal(fields['备注'], '准备算法题');
  assert.equal(fields['公司类型'], '互联网');
  assert.equal(fields['投递网址'].link, 'https://jobs.example.com/1');
  assert.equal(typeof fields['投递日期'], 'number');
});

test('reads Feishu text fields in string and rich-text response shapes', () => {
  assert.equal(readTextField('record-1'), 'record-1');
  assert.equal(readTextField([{ type: 'text', text: 'record-' }, { type: 'text', text: '2' }]), 'record-2');
});

test('rejects disallowed origins and invalid sync tokens', async () => {
  const handler = createHandler(async () => { throw new Error('should not fetch'); });
  const originResponse = await handler(request('/health', { origin: 'https://evil.example' }), env);
  assert.equal(originResponse.status, 403);
  const tokenResponse = await handler(request('/health', { token: 'wrong' }), env);
  assert.equal(tokenResponse.status, 401);
});

test('health verifies Feishu credentials and returns CORS headers', async () => {
  const handler = createHandler(async url => {
    assert.match(String(url), /tenant_access_token/);
    return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const response = await handler(request('/health'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://witchear.github.io');
  assert.equal((await response.json()).feishuReady, true);
});

test('sync upserts by 记录ID without deleting remote records', async () => {
  const calls = [];
  const mockFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
    if (String(url).includes('/fields')) return new Response(JSON.stringify({ code: 0, data: { items: [
      { field_id: 'primary', field_name: '记录标题', type: 1, is_primary: true },
      ...allFieldNames.map((field_name, index) => ({ field_id: `f${index}`, field_name, type: 1 }))
    ], has_more: false } }), { status: 200 });
    if (String(url).includes('batch_create') || String(url).includes('batch_update')) return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    if (String(url).includes('/records')) return new Response(JSON.stringify({ code: 0, data: { items: [{ record_id: 'remote-1', fields: { '记录ID': 'existing' } }], has_more: false } }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  const handler = createHandler(mockFetch);
  const response = await handler(request('/sync', { body: { target: { appToken: 'app', tableId: 'table' }, records: [
    { id: 'existing', company: '甲公司', position: '开发', stage: '已投递' },
    { id: 'new', company: '乙公司', position: '产品', stage: '笔试' }
  ] } }), env);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal(calls.filter(call => call.url.includes('batch_create')).length, 1);
  assert.equal(calls.filter(call => call.url.includes('batch_update')).length, 1);
  assert.equal(calls.some(call => /delete/i.test(call.url)), false);
});

test('connect validates the target table and initializes missing fields', async () => {
  const calls = [];
  let fieldsReads = 0;
  const mockFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/tables?')) return new Response(JSON.stringify({ code: 0, data: { items: [{ table_id: 'tbl456', name: '空白表' }], has_more: false } }), { status: 200 });
    if (String(url).includes('/fields?')) {
      fieldsReads += 1;
      const items = fieldsReads === 1
        ? [{ field_id: 'primary', field_name: '文本', type: 1, is_primary: true }]
        : [{ field_id: 'primary', field_name: '记录标题', type: 1, is_primary: true }, ...allFieldNames.map((field_name, index) => ({ field_id: `f${index}`, field_name, type: 1 }))];
      return new Response(JSON.stringify({ code: 0, data: { items, has_more: false } }), { status: 200 });
    }
    if (String(url).includes('/fields/primary') || (String(url).endsWith('/fields') && options.method === 'POST')) return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  const handler = createHandler(mockFetch);
  const response = await handler(request('/connect', { body: { bitableUrl: 'https://team.feishu.cn/base/app123?table=tbl456' } }), env);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.target.tableName, '空白表');
  assert.equal(calls.filter(call => call.options.method === 'POST' && call.url.endsWith('/fields')).length, allFieldNames.length);
  assert.equal(calls.some(call => call.options.method === 'PUT' && call.url.includes('/fields/primary')), true);
});

test('sync reports a rate-limited batch as a partial failure without changing local data', async () => {
  const mockFetch = async (url, options = {}) => {
    if (String(url).includes('/fields')) return new Response(JSON.stringify({ code: 0, data: { items: [
      { field_id: 'primary', field_name: '记录标题', type: 1, is_primary: true },
      ...allFieldNames.map((field_name, index) => ({ field_id: `f${index}`, field_name, type: 1 }))
    ], has_more: false } }), { status: 200 });
    if (String(url).includes('batch_create')) return new Response(JSON.stringify({ code: 99991400, msg: 'rate limited' }), { status: 429 });
    if (String(url).includes('/records')) return new Response(JSON.stringify({ code: 0, data: { items: [], has_more: false } }), { status: 200 });
    throw new Error(`unexpected fetch ${url} ${options.method || ''}`);
  };
  const handler = createHandler(mockFetch);
  const response = await handler(request('/sync', { body: { target: { appToken: 'app', tableId: 'table' }, records: [{ id: 'new', company: '乙公司', position: '产品', stage: '笔试' }] } }), env);
  const result = await response.json();
  assert.equal(response.status, 207);
  assert.equal(result.ok, false);
  assert.equal(result.created, 0);
  assert.match(result.message, /rate limited/);
});

test('network interruption returns a controlled error response', async () => {
  const isolatedEnv = { ...env, FEISHU_APP_ID: 'network-test-app' };
  const handler = createHandler(async () => { throw new Error('network interrupted'); });
  const response = await handler(request('/health'), isolatedEnv);
  const result = await response.json();
  assert.equal(response.status, 502);
  assert.equal(result.ok, false);
  assert.match(result.message, /network interrupted/);
});

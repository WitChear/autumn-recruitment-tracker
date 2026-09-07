const FEISHU_API = 'https://open.feishu.cn/open-apis';
const STAGES = ['待投递', '已投递', '笔试', '一面', '二面', 'HR面', 'Offer', '已结束'];
const COMPANY_TYPES = ['互联网', '央国企'];
const MAX_RECORDS = 1000;
const BATCH_SIZE = 500;

const FIELD_DEFINITIONS = [
  { name: '记录ID', type: 1 },
  { name: '公司', type: 1 },
  { name: '岗位', type: 1 },
  { name: '公司类型', type: 3, property: { options: COMPANY_TYPES.map((name, index) => ({ name, color: index + 1 })) } },
  { name: '城市', type: 1 },
  { name: '投递日期', type: 5, property: { date_formatter: 'yyyy-MM-dd' } },
  { name: '当前阶段', type: 3, property: { options: STAGES.map((name, index) => ({ name, color: index })) } },
  { name: '安排时间', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  { name: '安排事项', type: 1 },
  { name: '备注', type: 1 },
  { name: '投递网址', type: 15 },
  { name: '最后更新', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } }
];

let tokenCache = { appId: '', token: '', expiresAt: 0 };

function json(body, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders }
  });
}

function corsFor(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || 'https://witchear.github.io,http://localhost:8000,http://127.0.0.1:8000')
    .split(',').map(value => value.trim()).filter(Boolean);
  const localDevelopment = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!allowed.includes(origin) && !localDevelopment) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

export function parseBitableUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) { throw new Error('多维表格链接格式不正确'); }
  if (!/(^|\.)feishu\.cn$/i.test(url.hostname) && !/(^|\.)larksuite\.com$/i.test(url.hostname)) throw new Error('请填写飞书多维表格链接');
  const match = url.pathname.match(/\/base\/([A-Za-z0-9_-]+)/);
  const appToken = match?.[1] || '';
  const tableId = url.searchParams.get('table') || '';
  if (!appToken || !tableId) throw new Error('链接必须包含 /base/ 和 table 参数，请打开具体数据表后复制地址');
  return { appToken, tableId };
}

async function getTenantToken(env, fetchImpl) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Worker 尚未配置飞书应用凭据');
  if (tokenCache.appId === env.FEISHU_APP_ID && tokenCache.token && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;
  const response = await fetchImpl(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  });
  const result = await response.json();
  if (!response.ok || result.code) throw new Error(result.msg || '无法获取飞书访问令牌');
  tokenCache = { appId: env.FEISHU_APP_ID, token: result.tenant_access_token, expiresAt: Date.now() + (Number(result.expire) || 7200) * 1000 };
  return tokenCache.token;
}

async function feishuRequest(path, options, env, fetchImpl) {
  const token = await getTenantToken(env, fetchImpl);
  const response = await fetchImpl(`${FEISHU_API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(options?.headers || {}) }
  });
  let result;
  try { result = await response.json(); } catch (_) { throw new Error(`飞书返回了无法解析的响应（HTTP ${response.status}）`); }
  if (!response.ok || result.code) {
    const error = new Error(result.msg || `飞书接口返回 HTTP ${response.status}`);
    error.code = result.code || response.status;
    throw error;
  }
  return result.data || {};
}

async function listAll(path, env, fetchImpl) {
  const items = [];
  let pageToken = '';
  do {
    const joiner = path.includes('?') ? '&' : '?';
    const data = await feishuRequest(`${path}${joiner}page_size=500${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`, { method: 'GET' }, env, fetchImpl);
    items.push(...(data.items || []));
    pageToken = data.has_more ? String(data.page_token || '') : '';
  } while (pageToken);
  return items;
}

async function ensureFields(target, env, fetchImpl) {
  const basePath = `/bitable/v1/apps/${encodeURIComponent(target.appToken)}/tables/${encodeURIComponent(target.tableId)}/fields`;
  let fields = await listAll(basePath, env, fetchImpl);
  const primary = fields.find(field => field.is_primary);
  if (!primary) throw new Error('目标表没有可用的主字段');
  if (primary.field_name !== '记录标题') {
    await feishuRequest(`${basePath}/${encodeURIComponent(primary.field_id)}`, {
      method: 'PUT', body: JSON.stringify({ field_name: '记录标题', type: primary.type || 1 })
    }, env, fetchImpl);
  }
  for (const definition of FIELD_DEFINITIONS) {
    if (fields.some(field => field.field_name === definition.name)) continue;
    await feishuRequest(basePath, { method: 'POST', body: JSON.stringify({ field_name: definition.name, type: definition.type, ...(definition.property ? { property: definition.property } : {}) }) }, env, fetchImpl);
  }
  fields = await listAll(basePath, env, fetchImpl);
  return Object.fromEntries(fields.map(field => [field.field_name, field.field_id]));
}

function localDateTimestamp(value) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const timestamp = Date.parse(`${value}T00:00:00+08:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function localDateTimeTimestamp(value) {
  if (!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(value || ''))) return null;
  const timestamp = Date.parse(`${String(value).slice(0, 16)}:00+08:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function toFeishuFields(record) {
  const fields = {
    '记录标题': `${String(record.company || '').trim()}｜${String(record.position || '').trim()}`,
    '记录ID': String(record.id || ''),
    '公司': String(record.company || ''),
    '岗位': String(record.position || ''),
    '城市': String(record.city || ''),
    '当前阶段': STAGES.includes(record.stage) ? record.stage : '待投递',
    '安排事项': String(record.recentSchedule || ''),
    '备注': String(record.nextAction || record.notes || ''),
    '最后更新': Number(record.updatedAt) || Date.now()
  };
  if (COMPANY_TYPES.includes(record.companyType)) fields['公司类型'] = record.companyType;
  const applicationDate = localDateTimestamp(record.applicationDate);
  if (applicationDate !== null) fields['投递日期'] = applicationDate;
  const scheduleAt = localDateTimeTimestamp(record.scheduleAt);
  if (scheduleAt !== null) fields['安排时间'] = scheduleAt;
  if (/^https?:\/\//i.test(String(record.applicationUrl || ''))) fields['投递网址'] = { link: String(record.applicationUrl), text: '打开投递页面' };
  return fields;
}

export function readTextField(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : String(item?.text || item?.name || '')).join('');
  return String(value?.text || value?.name || '');
}

async function connectTable(payload, env, fetchImpl) {
  const target = parseBitableUrl(payload.bitableUrl);
  const tables = await listAll(`/bitable/v1/apps/${encodeURIComponent(target.appToken)}/tables`, env, fetchImpl);
  const table = tables.find(item => item.table_id === target.tableId);
  if (!table) throw new Error('应用无法访问该数据表，请确认已授权并使用具体数据表链接');
  await ensureFields(target, env, fetchImpl);
  return { ...target, tableName: table.name || '秋招投递记录' };
}

async function syncRecords(payload, env, fetchImpl) {
  const target = payload.target || {};
  if (!target.appToken || !target.tableId) throw new Error('缺少目标多维表格信息，请重新连接');
  if (!Array.isArray(payload.records)) throw new Error('records 必须是数组');
  if (payload.records.length > MAX_RECORDS) throw new Error(`单次最多同步 ${MAX_RECORDS} 条记录`);
  await ensureFields(target, env, fetchImpl);
  const basePath = `/bitable/v1/apps/${encodeURIComponent(target.appToken)}/tables/${encodeURIComponent(target.tableId)}/records`;
  const remoteRecords = await listAll(basePath, env, fetchImpl);
  const remoteBySourceId = new Map(remoteRecords.map(item => [readTextField(item.fields?.['记录ID']), item]).filter(([id]) => id));
  const creates = [];
  const updates = [];
  let skipped = 0;
  for (const record of payload.records) {
    if (!record?.id || !String(record.company || '').trim() || !String(record.position || '').trim()) { skipped += 1; continue; }
    const fields = toFeishuFields(record);
    const existing = remoteBySourceId.get(String(record.id));
    if (existing) updates.push({ record_id: existing.record_id, fields });
    else creates.push({ fields });
  }
  const failures = [];
  let created = 0;
  let updated = 0;
  for (let index = 0; index < creates.length; index += BATCH_SIZE) {
    const records = creates.slice(index, index + BATCH_SIZE);
    try { await feishuRequest(`${basePath}/batch_create`, { method: 'POST', body: JSON.stringify({ records }) }, env, fetchImpl); created += records.length; }
    catch (error) { failures.push(`新增批次 ${index / BATCH_SIZE + 1}：${error.message}`); }
  }
  for (let index = 0; index < updates.length; index += BATCH_SIZE) {
    const records = updates.slice(index, index + BATCH_SIZE);
    try { await feishuRequest(`${basePath}/batch_update`, { method: 'POST', body: JSON.stringify({ records }) }, env, fetchImpl); updated += records.length; }
    catch (error) { failures.push(`更新批次 ${index / BATCH_SIZE + 1}：${error.message}`); }
  }
  return { created, updated, skipped, failures, syncedAt: new Date().toISOString() };
}

export function createHandler(fetchImpl = fetch) {
  return async function handle(request, env) {
    const corsHeaders = corsFor(request, env);
    if (!corsHeaders) return json({ ok: false, message: '当前网页来源不允许访问同步服务' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== 'POST') return json({ ok: false, message: 'Method not allowed' }, 405, corsHeaders);
    if (!env.SYNC_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.SYNC_TOKEN}`) return json({ ok: false, message: '同步令牌无效' }, 401, corsHeaders);
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    let payload = {};
    try { payload = await request.json(); } catch (_) { return json({ ok: false, message: '请求内容不是有效 JSON' }, 400, corsHeaders); }
    try {
      if (path === '/health') {
        await getTenantToken(env, fetchImpl);
        return json({ ok: true, feishuReady: true }, 200, corsHeaders);
      }
      if (path === '/connect') return json({ ok: true, target: await connectTable(payload, env, fetchImpl) }, 200, corsHeaders);
      if (path === '/sync') {
        const result = await syncRecords(payload, env, fetchImpl);
        return json({ ok: result.failures.length === 0, ...result, ...(result.failures.length ? { message: result.failures.join('；') } : {}) }, result.failures.length ? 207 : 200, corsHeaders);
      }
      return json({ ok: false, message: 'Not found' }, 404, corsHeaders);
    } catch (error) {
      return json({ ok: false, message: error.message || '同步服务暂时不可用', code: error.code || undefined }, 502, corsHeaders);
    }
  };
}

export default { fetch: (request, env) => createHandler(fetch)(request, env) };

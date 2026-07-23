addKV = async (kv, key, value) => await kv.put(key, JSON.stringify(value))

async function handleRegister(request, env) {
  const ct = request.headers.get('content-type') || ''
  let data
  if (ct.includes('application/json')) {
    data = await request.json()
  } else if (ct.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData()
    data = {}
    for (const [k, v] of form.entries()) data[k] = v
  } else {
    // try JSON fallback
    try { data = await request.json() } catch (e) { return new Response('Unsupported content type', { status: 400 }) }
  }

  const name = (data.name || '').trim()
  const email = (data.email || '').trim()
  const phone = (data.phone || '').trim()
  const ticket_type = (data.ticket_type || '').trim()
  const guests = parseInt(data.guests || '0') || 0
  const prices = env.PRICES ? JSON.parse(env.PRICES) : { without_stay:5000, stay_single:8000, stay_double:7000, stay_triple:6500 }
  const amount = prices[ticket_type] || 0

  if (!name || !email || !ticket_type) return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } })

  const id = crypto.randomUUID()
  const created_at = new Date().toISOString()
  const record = { id, name, email, phone, ticket_type, guests, amount, created_at }
  await env.REGISTRATIONS.put(`r:${id}`, JSON.stringify(record))
  return new Response(JSON.stringify({ ok: true, id }), { status: 201, headers: { 'Content-Type': 'application/json' } })
}

async function listRegistrations(env) {
  // Note: list() is paginated; for simplicity we fetch up to 1000 keys
  const list = await env.REGISTRATIONS.list({ prefix: 'r:' })
  const keys = list.keys.map(k => k.name)
  if (keys.length === 0) return []
  const entries = await Promise.all(keys.map(k => env.REGISTRATIONS.get(k)))
  return entries.map(e => JSON.parse(e))
}

async function listExpenses(env) {
  const list = await env.EXPENSES.list({ prefix: 'e:' })
  const keys = list.keys.map(k => k.name)
  if (keys.length === 0) return []
  const entries = await Promise.all(keys.map(k => env.EXPENSES.get(k)))
  return entries.map(e => JSON.parse(e))
}

async function handleStats(request, env) {
  const adminHeader = request.headers.get('x-admin-token') || ''
  if (!adminHeader || adminHeader !== env.ADMIN_TOKEN) return new Response('Unauthorized', { status: 401 })

  const regs = await listRegistrations(env)
  const total_regs = regs.length
  const total_collected = regs.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const by_type = {}
  regs.forEach(r => {
    by_type[r.ticket_type] = by_type[r.ticket_type] || { count: 0, collected: 0 }
    by_type[r.ticket_type].count += 1
    by_type[r.ticket_type].collected += Number(r.amount) || 0
  })

  const expenses = await listExpenses(env)
  const total_spent = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0)
  const by_category = {}
  expenses.forEach(e => {
    by_category[e.category] = (by_category[e.category] || 0) + (Number(e.amount) || 0)
  })

  return new Response(JSON.stringify({ total_regs, total_collected, by_type, total_spent, by_category, expenses }), { headers: { 'Content-Type': 'application/json' } })
}

async function handleAddExpense(request, env) {
  const adminHeader = request.headers.get('x-admin-token') || ''
  if (!adminHeader || adminHeader !== env.ADMIN_TOKEN) return new Response('Unauthorized', { status: 401 })
  const ct = request.headers.get('content-type') || ''
  let data
  if (ct.includes('application/json')) data = await request.json()
  else {
    const form = await request.formData(); data = {};
    for (const [k, v] of form.entries()) data[k] = v
  }
  const category = (data.category || '').trim()
  const description = (data.description || '').trim()
  const amount = parseInt(data.amount || '0') || 0
  if (!category || !amount) return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  const id = crypto.randomUUID()
  const created_at = new Date().toISOString()
  const record = { id, category, description, amount, created_at }
  await env.EXPENSES.put(`e:${id}`, JSON.stringify(record))
  return new Response(JSON.stringify({ ok: true, id }), { status: 201, headers: { 'Content-Type': 'application/json' } })
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event))
})

async function handleRequest(request, event) {
  const url = new URL(request.url)
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() })
  }

  if (url.pathname === '/api/register' && request.method === 'POST') {
    const res = await handleRegister(request, event.request.cf || event)
    return new Response(res.body || res, { status: res.status || res.statusCode, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })
  }

  if (url.pathname === '/api/stats' && request.method === 'GET') {
    const res = await handleStats(request, event.request || event)
    return new Response(await res.text(), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })
  }

  if (url.pathname === '/api/expense' && request.method === 'POST') {
    const res = await handleAddExpense(request, event.request || event)
    return new Response(await res.text(), { status: res.status || 200, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })
  }

  // health
  if (url.pathname === '/api/health') return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })

  // fallback
  return new Response('Not found', { status: 404 })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-admin-token'
  }
}

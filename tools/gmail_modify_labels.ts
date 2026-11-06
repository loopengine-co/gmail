import type { AgentEnv, ToolDefinition } from 'loopengine'

// ---- Shared auth and request helpers -------------------------------
// Duplicated verbatim across every tool file in this ability: add-ability
// copies each tool file standalone, with no shared-module support, so
// this block is the contract between them. Keep the copies identical.
//
// Settings come from ctx.env, not process.env: loopengine resolves them
// per agent (see loopengine.ability.json's `scope`), so two agents can
// work in two different mailboxes.
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const accessTokens = new Map<string, { token: string; expiresAt: number }>()

async function gmailAccessToken(env: AgentEnv, action: string): Promise<string> {
  const clientId = env.get('GMAIL_CLIENT_ID')
  const clientSecret = env.get('GMAIL_CLIENT_SECRET')
  const refreshToken = env.get('GMAIL_REFRESH_TOKEN')
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`${action}: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN must all be set (see @loopengine-co/gmail's README)`)
  }
  const cached = accessTokens.get(refreshToken)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!res.ok || !body.access_token) {
    const reason = body.error ? `${body.error}${body.error_description ? `: ${body.error_description}` : ''}` : `HTTP ${res.status}`
    throw new Error(`${action}: Google refused the refresh token (${reason}). It may have been revoked or have expired; create a new one (see @loopengine-co/gmail's README).`)
  }
  accessTokens.set(refreshToken, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 })
  return body.access_token
}

async function gmailRequest<T>(env: AgentEnv, action: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await gmailAccessToken(env, action)
  const res = await fetch(`${GMAIL_API}/${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!res.ok) {
    throw new Error(`${action}: Gmail API error ${res.status}${body.error?.message ? `: ${body.error.message}` : ''}`)
  }
  return body
}
// ---- End of shared helpers -----------------------------------------

// Gmail's own system labels, which need no lookup.
const SYSTEM_LABELS = new Set(['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SPAM', 'TRASH', 'SENT', 'DRAFT'])

export const gmailModifyLabels: ToolDefinition = {
  name: 'gmail_modify_labels',
  description:
    'Add or remove labels on a Gmail message or a whole thread. Common uses: mark as read (remove "UNREAD"), archive (remove "INBOX"), star (add "STARRED"), or file under one of the mailbox\'s own labels by name (e.g. add "Handled"). Labels must already exist in the mailbox; system labels are INBOX, UNREAD, STARRED, IMPORTANT, SPAM and TRASH. Everything here can be undone by reversing it.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The message id, or the thread id when target is "thread".' },
      target: { type: 'string', enum: ['message', 'thread'], description: 'Change one message (default) or every message in a thread.' },
      add: { type: 'array', items: { type: 'string' }, description: 'Label names to add, e.g. ["STARRED"] or ["Handled"].' },
      remove: { type: 'array', items: { type: 'string' }, description: 'Label names to remove, e.g. ["UNREAD", "INBOX"] to mark read and archive.' },
    },
    required: ['id'],
  },
  execute: async (input, ctx) => {
    const action = 'gmail_modify_labels'
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (!id) throw new Error(`${action}: id is required`)
    const target = input.target === 'thread' ? 'threads' : 'messages'
    const names = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()) : [])
    const add = names(input.add)
    const remove = names(input.remove)
    if (add.length === 0 && remove.length === 0) throw new Error(`${action}: give at least one label to add or remove`)

    // Map names to ids: system labels by their own id, user labels by
    // name (case-insensitive), looked up once.
    let userLabels: { id: string; name: string }[] | undefined
    const toId = async (name: string): Promise<string> => {
      if (SYSTEM_LABELS.has(name.toUpperCase())) return name.toUpperCase()
      userLabels ??= (await gmailRequest<{ labels?: { id: string; name: string }[] }>(ctx.env, action, 'labels')).labels ?? []
      const match = userLabels.find((l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name)
      if (!match) {
        const available = userLabels.filter((l) => !SYSTEM_LABELS.has(l.id)).map((l) => l.name)
        throw new Error(`${action}: no label named "${name}" in this mailbox. Existing labels: ${available.join(', ') || 'none'}`)
      }
      return match.id
    }
    const addLabelIds = await Promise.all(add.map(toId))
    const removeLabelIds = await Promise.all(remove.map(toId))

    await gmailRequest(ctx.env, action, `${target}/${encodeURIComponent(id)}/modify`, { method: 'POST', body: { addLabelIds, removeLabelIds } })
    return JSON.stringify({ id, target: target === 'threads' ? 'thread' : 'message', added: add, removed: remove })
  },
}

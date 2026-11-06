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

interface MessageMeta {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  payload?: { headers?: { name: string; value: string }[] }
}

function headerValue(meta: MessageMeta, name: string): string {
  return meta.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

export const gmailSearch: ToolDefinition = {
  name: 'gmail_search',
  description:
    'Search this agent\'s Gmail mailbox and list matching messages, newest first: id, thread_id, from, to, subject, date, a short snippet, and whether it is unread. query uses Gmail\'s own search syntax, the same as the Gmail search box: e.g. "is:unread in:inbox", "from:alice@example.com newer_than:7d", "subject:(invoice) has:attachment". Use gmail_get_message or gmail_get_thread to read a message in full.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'A Gmail search query, e.g. "is:unread in:inbox". Leave empty to list the most recent messages.' },
      max_results: { type: 'number', description: 'How many messages to return, 1 to 25. Default 10.' },
    },
    required: [],
  },
  execute: async (input, ctx) => {
    const action = 'gmail_search'
    const query = typeof input.query === 'string' ? input.query : ''
    const max = Math.max(1, Math.min(25, Math.floor(Number(input.max_results) || 10)))

    const params = new URLSearchParams({ maxResults: String(max) })
    if (query) params.set('q', query)
    const list = await gmailRequest<{ messages?: { id: string }[]; nextPageToken?: string }>(ctx.env, action, `messages?${params}`)

    const metaParams = 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date'
    const messages = await Promise.all(
      (list.messages ?? []).map(async ({ id }) => {
        const meta = await gmailRequest<MessageMeta>(ctx.env, action, `messages/${encodeURIComponent(id)}?${metaParams}`)
        return {
          id: meta.id,
          thread_id: meta.threadId,
          from: headerValue(meta, 'From'),
          to: headerValue(meta, 'To'),
          subject: headerValue(meta, 'Subject'),
          date: headerValue(meta, 'Date'),
          snippet: meta.snippet ?? '',
          unread: (meta.labelIds ?? []).includes('UNREAD'),
        }
      }),
    )
    return JSON.stringify({ messages, more_available: Boolean(list.nextPageToken) })
  },
  safe: true,
}

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

// ---- Message reading helpers (same in gmail_get_message and gmail_get_thread)
interface MessagePart {
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: MessagePart[]
}

interface FullMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  payload?: MessagePart
}

function partHeader(part: MessagePart | undefined, name: string): string {
  return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decodeBase64Url(data: string | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : ''
}

function findBody(part: MessagePart | undefined, mimeType: string): string | undefined {
  if (!part) return undefined
  if (part.mimeType === mimeType && part.body?.data && !part.filename) return decodeBase64Url(part.body.data)
  for (const child of part.parts ?? []) {
    const found = findBody(child, mimeType)
    if (found !== undefined) return found
  }
  return undefined
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function listAttachments(part: MessagePart | undefined, out: { filename: string; mime_type: string; size: number }[] = []) {
  if (!part) return out
  if (part.filename && part.body?.attachmentId) out.push({ filename: part.filename, mime_type: part.mimeType ?? '', size: part.body.size ?? 0 })
  for (const child of part.parts ?? []) listAttachments(child, out)
  return out
}

function describeMessage(message: FullMessage, maxBodyChars: number) {
  const plain = findBody(message.payload, 'text/plain')
  const html = plain === undefined ? findBody(message.payload, 'text/html') : undefined
  const body = (plain ?? (html !== undefined ? htmlToText(html) : message.snippet ?? '')).trim()
  return {
    id: message.id,
    thread_id: message.threadId,
    from: partHeader(message.payload, 'From'),
    to: partHeader(message.payload, 'To'),
    cc: partHeader(message.payload, 'Cc'),
    subject: partHeader(message.payload, 'Subject'),
    date: partHeader(message.payload, 'Date'),
    unread: (message.labelIds ?? []).includes('UNREAD'),
    labels: message.labelIds ?? [],
    body: body.length > maxBodyChars ? `${body.slice(0, maxBodyChars)}\n[… truncated, ${body.length - maxBodyChars} more characters]` : body,
    attachments: listAttachments(message.payload),
  }
}
// ---- End of message reading helpers

export const gmailGetThread: ToolDefinition = {
  name: 'gmail_get_thread',
  description:
    'Read a whole Gmail conversation, oldest message first: each message\'s from, to, subject, date and plain-text body. Use this before replying, so the reply answers what was actually said and doesn\'t repeat earlier answers. thread_id comes from gmail_search or gmail_get_message.',
  input_schema: {
    type: 'object',
    properties: {
      thread_id: { type: 'string', description: 'The thread id, from gmail_search or gmail_get_message.' },
    },
    required: ['thread_id'],
  },
  execute: async (input, ctx) => {
    const action = 'gmail_get_thread'
    const threadId = typeof input.thread_id === 'string' ? input.thread_id.trim() : ''
    if (!threadId) throw new Error(`${action}: thread_id is required`)
    const thread = await gmailRequest<{ id: string; messages?: FullMessage[] }>(ctx.env, action, `threads/${encodeURIComponent(threadId)}?format=full`)
    const messages = thread.messages ?? []
    // Long threads: keep every message, but shorten each body so the
    // newest ones (usually what matters) still fit.
    const perMessage = Math.max(1_500, Math.floor(30_000 / Math.max(1, messages.length)))
    return JSON.stringify({ thread_id: thread.id, messages: messages.map((m) => describeMessage(m, perMessage)) })
  },
  safe: true,
}

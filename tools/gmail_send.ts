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

// ---- Composing helpers (same in gmail_create_draft and gmail_send)
interface Composed {
  to: string
  cc?: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string
}

// Header values come from the model: strip line breaks so a value can
// never start a new header (header injection).
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function encodeHeaderValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function buildRawMessage(email: Composed): string {
  const headers = [
    `To: ${oneLine(email.to)}`,
    ...(email.cc ? [`Cc: ${oneLine(email.cc)}`] : []),
    `Subject: ${encodeHeaderValue(oneLine(email.subject))}`,
    ...(email.inReplyTo ? [`In-Reply-To: ${oneLine(email.inReplyTo)}`, `References: ${oneLine(email.references || email.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  const body = Buffer.from(email.body, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n')
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url')
}

interface ReplyContext {
  threadId: string
  to: string
  subject: string
  inReplyTo: string
  references: string
}

// A reply must carry the original's Message-ID in In-Reply-To and
// References, and go in its thread, or recipients see a new conversation.
async function replyContext(env: AgentEnv, action: string, messageId: string): Promise<ReplyContext> {
  const params = ['Message-ID', 'References', 'Subject', 'From', 'Reply-To'].map((h) => `metadataHeaders=${h}`).join('&')
  const original = await gmailRequest<{ threadId: string; payload?: { headers?: { name: string; value: string }[] } }>(
    env,
    action,
    `messages/${encodeURIComponent(messageId)}?format=metadata&${params}`,
  )
  const header = (name: string) => original.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
  const subject = header('Subject')
  const inReplyTo = header('Message-ID')
  return {
    threadId: original.threadId,
    to: header('Reply-To') || header('From'),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    inReplyTo,
    references: [header('References'), inReplyTo].filter(Boolean).join(' '),
  }
}

async function composeFromInput(env: AgentEnv, action: string, input: Record<string, unknown>): Promise<{ raw: string; threadId?: string; to: string; subject: string }> {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '')
  const body = typeof input.body === 'string' ? input.body : ''
  if (!body.trim()) throw new Error(`${action}: body is required`)
  const replyTo = text('reply_to_message_id')
  const reply = replyTo ? await replyContext(env, action, replyTo) : undefined
  const to = text('to') || reply?.to || ''
  const subject = text('subject') || reply?.subject || ''
  if (!to) throw new Error(`${action}: to is required (or reply_to_message_id, to reply to its sender)`)
  if (!subject) throw new Error(`${action}: subject is required for a new email`)
  const raw = buildRawMessage({ to, cc: text('cc') || undefined, subject, body, inReplyTo: reply?.inReplyTo, references: reply?.references })
  return { raw, threadId: reply?.threadId, to, subject }
}

const COMPOSE_PROPERTIES = {
  to: { type: 'string', description: 'Recipient address(es), comma-separated. Optional when replying: defaults to the original sender.' },
  cc: { type: 'string', description: 'Optional CC address(es), comma-separated.' },
  subject: { type: 'string', description: 'Subject line. Optional when replying: defaults to "Re: <original subject>".' },
  body: { type: 'string', description: 'The email body, as plain text.' },
  reply_to_message_id: { type: 'string', description: 'To reply in an existing conversation, the id of the message being answered (from gmail_search). The email then goes in that thread.' },
} as const
// ---- End of composing helpers

export const gmailSend: ToolDefinition = {
  name: 'gmail_send',
  description:
    'Send an email from this agent\'s Gmail mailbox, or send a draft saved earlier with gmail_create_draft (pass its draft_id; the other fields are then ignored). Set reply_to_message_id to reply in an existing conversation, so it lands in the same thread. Sending can\'t be undone, so by default a person approves every send. Returns message_id and thread_id.',
  input_schema: {
    type: 'object',
    properties: {
      draft_id: { type: 'string', description: 'Send this saved draft (from gmail_create_draft) instead of composing a new email.' },
      ...COMPOSE_PROPERTIES,
    },
    required: [],
  },
  execute: async (input, ctx) => {
    const action = 'gmail_send'
    const draftId = typeof input.draft_id === 'string' ? input.draft_id.trim() : ''
    if (draftId) {
      const sent = await gmailRequest<{ id: string; threadId: string }>(ctx.env, action, 'drafts/send', { method: 'POST', body: { id: draftId } })
      return JSON.stringify({ message_id: sent.id, thread_id: sent.threadId, sent_draft: draftId })
    }
    const { raw, threadId, to, subject } = await composeFromInput(ctx.env, action, input)
    const sent = await gmailRequest<{ id: string; threadId: string }>(ctx.env, action, 'messages/send', {
      method: 'POST',
      body: { raw, ...(threadId ? { threadId } : {}) },
    })
    return JSON.stringify({ message_id: sent.id, thread_id: sent.threadId, to, subject })
  },
}

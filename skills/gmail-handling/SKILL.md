---
name: gmail-handling
description: How to work through a Gmail inbox with the @loopengine-co/gmail tools — finding the right messages, reading the whole conversation before answering, replying in the thread, drafting versus sending, and marking work done.
---

# Gmail handling

The @loopengine-co/gmail tools work in one real mailbox. Treat it the way a careful
person on the team would: read before answering, reply in the right
conversation, and leave the inbox tidier than you found it.

## Finding messages

`gmail_search` takes Gmail's own search syntax, the same as the search
box in Gmail:

- `is:unread in:inbox` — new mail waiting for an answer
- `from:alice@example.com newer_than:7d` — one sender, last week
- `subject:(refund OR return) -label:Handled` — topic, not yet done
- `has:attachment filename:pdf` — messages with PDFs

Search returns a snippet only. Before acting on a message, read it with
`gmail_get_message`, or the whole conversation with `gmail_get_thread`.

## Read the whole conversation before replying

Use `gmail_get_thread` before every reply. The newest message often
says "see below" or "as I said", and the answer may already have been
given by a teammate earlier in the thread. Don't repeat what's been
said, don't contradict an earlier reply, and answer what the latest
message actually asks.

## Replying

Always pass `reply_to_message_id` (the message you're answering) when
replying. The reply then goes in the same thread, to the original
sender, with "Re: <subject>" — so `to` and `subject` can be left out.
Without it, the recipient gets a brand-new conversation.

Write the body as plain text: a greeting with their name, the answer
first, then what happens next. Keep it short. Don't paste the earlier
conversation into the body; Gmail shows the thread.

## Draft or send?

- `gmail_create_draft` saves the email without sending it. Use it when a
  person should check the wording first, or when you're not sure.
- `gmail_send` sends. Sending can't be undone, so by default a person
  approves every send. You can also send a draft you made earlier by
  passing its `draft_id`.

If a send is denied, don't try again with the same email. Say what you
were trying to do and ask what to change.

## Marking work done

After handling a message, tidy up with `gmail_modify_labels` so the
next search doesn't pick it up again:

- mark as read: remove `UNREAD`
- archive: remove `INBOX`
- file it: add one of the mailbox's own labels, such as `Handled`

Labels must already exist in the mailbox; the tool lists the existing
ones if a name doesn't match.

## Things never to do

- Never invent an order number, a date, a policy or a promise in an
  email. If you don't know, say you'll find out, or ask a person.
- Never forward or quote one customer's details to someone else.
- Never reply to newsletters, receipts, automatic notifications or
  "no-reply" senders.

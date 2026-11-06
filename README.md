# @loopengine-co/gmail

A [loopengine](https://github.com/loopengine-co/loopengine) ability: Gmail
tools to search a mailbox, read whole conversations, draft, label and send
email, plus a skill on handling an inbox well. Sending asks a person first
by default.

```sh
npx loopengine add-ability @loopengine-co/gmail --agent <your-agent>
```

## What's in it

- **Tools**
  - `gmail_search(query?, max_results?)` — Gmail search syntax
    (`is:unread in:inbox`, `from:… newer_than:7d`); returns id, thread_id,
    from, to, subject, date, snippet and unread for each match.
  - `gmail_get_message(id)` — one message in full: headers, labels, the
    plain-text body (HTML-only mail converted to text), attachment names.
  - `gmail_get_thread(thread_id)` — the whole conversation, oldest first.
  - `gmail_create_draft(body, to?, cc?, subject?, reply_to_message_id?)` —
    saves a draft without sending.
  - `gmail_send(…same…, draft_id?)` — sends a new email or reply, or a
    saved draft by its `draft_id`.
  - `gmail_modify_labels(id, add?, remove?, target?)` — mark read (remove
    `UNREAD`), archive (remove `INBOX`), star, or file under a label by
    name; on one message or a whole thread.

  With `reply_to_message_id`, a draft or send goes in the original
  thread, to the original sender, with `In-Reply-To`/`References` set and
  a "Re:" subject, so it shows as a reply in every mail client.
- **Skill** — `gmail-handling`: search syntax, reading the thread before
  replying, replying in-thread, draft versus send, tidying up with labels,
  and what never to put in an email.
- **actauth rules** — reading, drafting and labelling are `allow` (nothing
  leaves the mailbox, and each can be undone); `gmail_send` is `ask`.

## Setup (about five minutes)

The tools use the Gmail API with an OAuth refresh token for the mailbox
the agent works in.

1. In the [Google Cloud console](https://console.cloud.google.com/), pick
   or create a project and enable the **Gmail API**
   (APIs & Services → Library).
2. Set up the **OAuth consent screen** (APIs & Services → OAuth consent
   screen). "Internal" is simplest for a Google Workspace domain; for
   "External", add the mailbox as a test user.
3. Create credentials → **OAuth client ID** → application type
   **Desktop app**. Note the client ID and secret.
4. Get a refresh token for the mailbox, for example with the
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):
   open its settings (gear icon), tick "Use your own OAuth credentials",
   enter the client ID and secret, authorize the scope
   `https://www.googleapis.com/auth/gmail.modify` signed in as the
   mailbox, then exchange the code for tokens and copy the refresh token.
5. Set the three values in the agent's **Environment** tab in the console:

| Setting | |
| --- | --- |
| `GMAIL_CLIENT_ID` | The OAuth client ID |
| `GMAIL_CLIENT_SECRET` | The OAuth client secret (secret) |
| `GMAIL_REFRESH_TOKEN` | The mailbox's refresh token (secret) |

All three are shared by default; give an agent its own values to have it
work in a different mailbox.

`gmail.modify` lets the agent read, label, draft and send. It can't
permanently delete mail. A refresh token for an "External" app in testing
mode expires after 7 days; publish the consent screen (or use "Internal")
for one that lasts.

## Permissions

| Tool | Default | Why |
| --- | --- | --- |
| `gmail_search`, `gmail_get_message`, `gmail_get_thread` | allow | Read only |
| `gmail_create_draft` | allow | Saved, not sent; a draft can be deleted |
| `gmail_modify_labels` | allow | Undone by reversing it |
| `gmail_send` | ask | An email can't be recalled once sent |

Change these in the agent's Permissions tab. For example, once its replies
are reliably right, allow `gmail_send` for one kind of email with a `when`
condition, rather than for everything.

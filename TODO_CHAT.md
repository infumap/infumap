# Chat: fixed setup, cache-stable prompts, transcript redesign

Design direction from discussion (2026-11-18), not yet implemented, except "Optional profiles" (done, 035a76c6).
Back/forward compatibility of transcripts and saved `.chat` items is **not** a constraint: aim for the ideal design.

## Goals

In priority order:

1. **Successive requests hit the LLM prefix cache.** Every request in a chat, across turns, extends the previous
   request's prompt and never rewrites it. Re-processing a long chat's history on every turn is the cost being
   removed (llama.cpp keeps only the last prompt per slot, so a rewrite means a full re-prefill).
2. **The transcript is a record of exactly what the model was given.** Every request body can be reconstructed from
   it, so it can be used to understand what happened in a chat.
3. **Less flexibility in a chat.** Tools and scope are a property of the chat, not of each turn.
4. **Deep research is not a chat.** It is a separate kind of run that produces a report (see "Deep research").

## Done: optional profiles

A new account had a "Default" query profile created on its first request, with the model snapshotted at that moment.
On a new server that was usually `model: null`, and it stayed that way after providers were configured.

Now profiles are optional. Without a default profile, a new query starts from `defaultConfiguration` in the
`/chat/models` response, which the server works out from the current catalog on every request and never saves. The
last profile can be deleted; deleting or un-defaulting the default leaves no default.

## Current behaviour (as of 035a76c6)

### What the transcript is

The module comment ([transcript.rs](infumap/src/web/routes/command/chat/transcript.rs)) defines it as the
authoritative copy of the conversation: a request carries only the new message, and the model history is built from
the file. It was not designed as a record of what was sent. In practice it does three jobs with one record shape and
nothing saying which field serves which:

- **Conversation state.** `history()` builds the model history from completed turns. Sound.
- **Chat view and composer state.** `rounds` feeds the activity dropdown, including partial rounds of failed turns.
  `settings` is the composer setup as *selected*; the last turn's settings are restored into the query on load
  ([chat.ts](web/src/items/chat.ts), `restoreQueryConfiguration`). That is why scope is stored as `everything` even
  when Infumap tools are off: it is saved composer state, not a fact about the turn.
- **Archive.** Persisting a chat freezes the file into a `.chat` item. This is the job it does worst.

Weaknesses:

- **Fields from the three jobs are mixed.** Reading the file, you can't tell which fields describe what happened.
- **History is not stored as sent.** User messages are stored as parts (text, attachments, skills) and turned back
  into text by `UserRecord::model_content()` on every request with the current code. A change to the wrapper text
  changes what old chats send and breaks their cache, unrecorded.
- **Each turn is stored twice.** `messages` (what the model gets back) and `rounds` (what the view shows) overlap:
  reasoning, answers, tool calls, arguments.
- **Not recorded at all:**
  - the system prompt (rebuilt every request by `chat_system_prompt` in
    [chat/mod.rs](infumap/src/web/routes/command/chat/mod.rs));
  - tool definitions (Infumap specs are in code; tool-server schemas are fetched live; the LLM log keeps only names);
  - system messages added during a turn (`chat_history_from_wire_messages` drops every system message);
  - provider-specific request fields (e.g. how reasoning effort is sent);
  - the server version.

Skills *are* recorded: each is an attachment on the user record, mimeType `text/vnd.infumap.inline-skill+markdown`,
title = the slash mention, full Markdown. Not under `settings`. The chat view hides them on purpose
(`load_chat_response` filters them out) because the mention is already in the message text.

### What breaks the cache today

Within one turn, requests are append-only. Between turns:

1. **The system prompt is rebuilt every turn,** and changes (rewriting the whole history) when:
   - the UTC date changes ("Today is …");
   - the scope changes (scope paragraph);
   - tools are switched on or off (tool-server paragraph);
   - the mode switches between Chat and Deep research (deep-research paragraph).
2. **System messages added during a turn are dropped from later history:** the web-search reminder (after four
   searches in Chat) and the deep-research review and final prompts. The next turn diverges at that point, so the
   turn's tool results, usually most of the tokens, are processed again.
3. **The final deep-research request sends no tools** (`run_chat_model_round(..., &[], ...)`). Templates put tool
   definitions near the front, so that request most likely misses, and with one slot the next turn misses again.
4. **Changing the tool set** changes the prefix: a tool server switched on or off, changing its schemas, or dropping out.
5. **Possibly reasoning.** Earlier assistant messages are re-sent with `reasoning_content`, but some chat templates
   strip reasoning from earlier turns, which diverges at the previous answer. Template-dependent; not yet checked
   against the models in use.
6. **Re-rendering user messages** (see above): only when the wrapper code changes.

Moving deep research out of chat (see "Deep research") removes the deep-research parts of 1 and 2, and all of 3, from
chat rather than fixing them there.

## Decided

### Fixed setup per chat

Tool set and scope are chosen before the first message and fixed for the life of the chat. To change them, start a
new chat that references the old one (see "Chat about an item"). Chat has no mode: deep research is separate.

- **Tool definitions are stored at the first turn** and sent unchanged every turn. Calls to a tool server that has
  since gone away return an "unavailable" tool error rather than changing the prompt. A server changing its schemas
  does not affect existing chats.
- **Scope is fixed as a reference, not as content.** A collection's contents can change; they reach the model through
  tool results, which are appended. The collection's *name* as of the first turn is kept, so a rename does not rewrite
  the prompt.
- With Infumap tools off, a chat has no scope. The "scope with tools off" confusion goes away.
- Tool approval policy is not part of the prompt and can stay editable.

### The system prompt never changes within a chat

Built once at the first turn and never rewritten. The date is the chat's start date (header `createdAt`).

Everything that varies is appended, never inserted earlier. In particular, system messages added during a turn (the
web-search reminder) are kept in history, so the next turn's prefix is exactly what was sent.

### Deep research

Deep research is an autonomous job, not a chat: a question and inputs go in, a strategy runs, a report comes out. It is
not continuable. A chat is a sequence of single-step turns; sharing one format is what made chat cope with deep
research's stages, extra prompts and tool-less final request.

- **Strategies.** A run is a strategy + parameters + inputs (question, scope, tool set, models, attachments). Today's
  pipeline (research, evidence review, final report) becomes the first strategy. More are expected later (not a
  priority), some calling several models at once. Implement one strategy; don't design a strategy interface before
  there is a second one to shape it.
- **Its own run log, not a chat transcript.** A set of request records, each with an id, the model, exact request
  fields, the messages it was sent, and which earlier requests it depended on. That allows parallel branches across
  models without requiring them now. Same principles as the chat transcript redesign: an append-only log of facts,
  messages stored as sent, tool sets by hash, request records written before sending, server version.
- **Cache.** Within one sequential branch, the same rule as chat: each request extends the previous one. If a final
  report step must not use tools, keep the tool definitions and set `tool_choice: "none"` rather than dropping them
  (check that llama.cpp renders the prompt unchanged with it).
- **The report becomes an item on Keep:** a document page with its run log attached, so sources and tool calls can be
  inspected. It can then be linked and attached like anything else.
- **Follow-up questions** go in a new chat with the report attached ("Chat about an item").
- **Its own run view** (below). The progress view is where parallel branches or several models would show later; the
  chat activity dropdown can't show them.

Costs: a second log format and a second view; asking about a report takes the extra step of starting a chat.

#### Deep research UI

**Entry point: New Query, unchanged.** The selector keeps Search / Chat / Deep research; Deep research now creates a
*research run*, not a chat. New Query stays the one place to start anything. Rejected: a separate Research page (more
navigation, splits history); a per-message choice inside a chat (goes away with chat's mode). Earlier chats don't
offer Deep research.

**Runs live in the Queries list next to chats,** with the binoculars icon and a status: running, waiting for you,
done, stopped, failed. Named from the question. Selecting one opens the run view.

**Before starting:** the same input as chat: question, attachments, skills, scope, tools, model. A strategy picker
appears only once there is a second strategy.

**Run view:**

```
┌ What changed in EU AI Act enforcement since June?            ⟳ Running · 6 min ┐
│ Scope: Everything · Tools: Infumap, Web search · Model: qwen3-32b             │
│                                                                              │
│ ✓ Research         14 searches · 9 sources read                     [details]│
│ ● Reviewing evidence                                                         │
│ ○ Writing report                                                     [Stop]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Running:** the question and its fixed setup, read-only; progress per strategy stage, each with expandable live
  activity (searches, sources read); **Stop**.
- **Done:** the report as a document, a list of sources, the activity collapsed below. Actions:
  - **Keep:** puts the report into the item tree as a document page, with the run log attached. Decided: only on Keep,
    never automatically (matches chats; otherwise every run adds pages to the tree).
  - **Chat about this report:** New Query in Chat with the report attached.
  - **Run again:** fills New Query with the same question and setup, editable. This is how the model or scope is
    changed: a new run, not an edit of the old one.
- **Stopped or failed:** the evidence gathered so far, the error, **Run again**.

**Runs are background jobs.** Today a run stops after five minutes with no viewer connected
([chat/mod.rs](infumap/src/web/routes/command/chat/mod.rs), `RunCancellation::Detached`). A research run can take
longer, and closing the browser must not kill it. Limit runs by their own budget (time, rounds, tokens), not by
whether anyone is watching. The list status shows completion; a browser notification could come later.

**Several strategies and models later:** the progress view is organised by stage, and a stage can hold parallel
branches (one per model or sub-question). Today's strategy is three stages with one branch each, so nothing extra is
built now; this only keeps the view's structure from needing rework.

#### Asking the user (proposed)

Clarifying questions, at the start or at a genuine fork mid-run, via an `ask_user` tool in research runs:

- Reuses the tool-approval pause (`AwaitingApproval`, prompt in the activity view, resume on response), with a text
  answer instead of approve/deny. Recorded in the run log as an ordinary tool call and result.
- Offered for the whole run, so the tool set never changes (cache). Not offered only in the first stage: removing a
  tool mid-run changes the prefix.
- **Never blocks an unwatched run:** after a wait window with no answer, the result is "no answer; proceed on your best
  assumption and state it in the report".
- **Capped per run** (e.g. 2 calls). The strategy prompt says to ask at the start if the question is ambiguous. Local
  models may ask instead of searching; needs trying.
- UI: a question card with an answer box (buttons when the model offers options); list status "Waiting for you".
- Not in chat for now: the model can ask in its reply and the user answers next turn, which already works and keeps
  the cache.

## Open decisions

1. **Model: changeable or fixed?** Recommendation: changeable. A different model never had the cache, so switching
   costs nothing extra, and "try a stronger model" is common. Reasoning effort also changeable, accepting that some
   templates put effort in the system prompt (gpt-oss: "Reasoning: high"), so for those models a change rewrites the
   start.
2. **Current date in a resumed chat.** A chat continued on a later day tells the model the start date. Option: put the
   current date in the new user message (appended, so cache-safe). Leave out if the start date is enough.

## Transcript redesign

One rule: **the file is an append-only log of facts; everything else is derived from it.**

1. **Header:** format version, query item, created-at, server version, and the chat's fixed setup: tool set (by
   hash), scope (with the collection name as of the start), system prompt as sent.
2. **Messages stored as sent, structure as annotations.** A user message is stored as the exact text the model got,
   wrappers included, with spans marking parts ("bytes 0–812: skill `/review-code` from item X", "bytes 813–5000:
   attachment `notes.md`"). The view builds chips from spans and hides skills. Nothing is re-rendered later.
3. **One message sequence, each message tagged with whether it carries:**
   - `carried`: user, assistant and tool messages of completed turns, plus system messages added during them. This
     is the history.
   - `discarded`: partial output of failed or cancelled turns. Shown in the view, never sent again.

   The `rounds` copy goes away. Display-only details (duration, summary, source, result preview) become annotations
   on the tool-result message.
4. **A request record per model call:** provider, model, exact provider-specific fields, tool set hash, range of
   message numbers sent, token usage and timing. The exact request body = those fields + those messages + that tool
   set. Written *before* the request is sent, so a crash still leaves a record.
5. **Tool sets** written once as their own records, referenced by hash.
6. **Events:** tool approval `{callId, decision, at}`; turn end `{outcome, error}`. "Running" and "awaiting approval"
   are derived from the log.
7. **Composer settings move out of the transcript** into query item state, like the draft. The log keeps what was
   used, not what was selected. If the applied profile is worth showing, it becomes a display annotation on the turn.
8. **Model per turn.** If the model is changeable (open decision 1), each request record names it; nothing else
   changes.

What this gets: exact reconstruction of every request; messages stored once (attachment and skill text only inside
the message that carried them); view, history and "is this item already in the chat" all from the same facts; a saved
`.chat` item is a complete self-contained record.

Costs: the chat view builds chips from spans and turns from messages and events instead of reading ready-made
`rounds`; tool schemas add size (once per distinct set); moving composer state out touches the query item and the
reload path.

## Chat about an item

One action, "start a chat with this attached", available from any item's toolbar or context menu, covers both:

- **Continuing from an earlier chat** with different tools or scope. Does not exist yet: a live chat can't currently be
  attached, and the whole transcript is the wrong attachment (tool results make it huge). Define a rendering of a chat
  as an attachment: user messages and assistant answers, without tool calls or results. A "New chat from this one"
  action creates a chat with that rendering attached.
- **Asking about a deep-research report**, which is an item.

## Composer

- Scope and tools are editable until the first message is sent, then shown read-only as the chat's setup.
- Profile chips apply only before the first turn.
- Model (and effort) stay editable if open decision 1 goes that way.
- No Chat / Deep research toggle; deep research has its own entry point.

## Verification

- A test that runs two or more turns, including one with the web-search reminder, and asserts each request's messages
  and tools start with the previous request's. The same check within each sequential branch of a research run.
- Extend the LLM log's rewrite marker (`llm_request_log_value`), which today only compares requests within one run, to
  compare across turns of the same chat.
- Check open item 5 under "What breaks the cache today" (reasoning and templates) against the models actually used.

## Suggested order

1. Cache fixes that don't depend on the redesign: system prompt fixed at the first turn with the start date; keep
   system messages added during a turn in history. Add the cross-turn prefix test.
2. Deep research out of chat: research runs in the Queries list, run log, run view, Keep / Chat about this report /
   Run again, background jobs; the current pipeline as the first strategy. Removes the mode from chat. `ask_user`
   after that, once the pause plumbing is shared.
3. Fixed setup per chat (tools with stored definitions, scope), and the read-only composer after the first turn.
   Needs open decision 1.
4. Chat transcript redesign.
5. Chat about an item.

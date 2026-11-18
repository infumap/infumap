# Chat: fixed setup, cache-stable prompts, transcript redesign

Design direction from discussion (2026-11-18). Done: "Optional profiles" (035a76c6), step 1 of "Suggested order"
(ce0c470a) and step 3 (fixed setup per chat; taken before step 2 as it is smaller and finishes the cache work for
plain chat).
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

1. ~~Model: changeable or fixed?~~ **Decided: changeable**, with reasoning effort and tool approval. A different model
   never had the cache, and "try a stronger model" is common. Accepted: templates that put effort in the system prompt
   (gpt-oss: "Reasoning: high") rewrite the start when effort changes.
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
- **At the start of manual testing** (deferred until the steps below are in place, so testing gives one baseline):
  record the provider's reused-token count per request in the LLM log and each round's activity. llama-server:
  `timings.cache_n` alongside `prompt_n`; OpenRouter: `usage.prompt_tokens_details.cached_tokens` (check both field
  names against real responses). The prefix test compares the JSON sent, not the prompt the template renders, so only
  this shows template-side misses such as stripped reasoning. Today only `usage.prompt_tokens` is read.

## Suggested order

1. **Done.** Cache fixes that don't depend on the redesign: the system prompt dates from the chat's start (header
   `createdAt`; a continued chat keeps its source's); system messages added during a turn are kept in history and
   sent again; the LLM log compares a turn's first request with the previous turn's last (messages and tool
   definitions); `every_request_extends_the_one_before_it_across_turns` runs two deep-research turns against a fake
   model server and checks each request extends the one before.
2. Deep research out of chat, in slices, each usable on its own:
   1. **Done.** Research run on the server (`chat/research.rs`). `POST /research/start` takes a chat request body on
      a fresh query item in the Queries page and returns the live stream. A run loads through `load-chat` as a chat of
      one turn (question, then report) with a `research` field naming its stages; the separate `/research/load` route
      was dropped as a duplicate. Following, stopping and tool approvals reuse
      `/chat/resume`, `/chat/cancel` and `/chat/tool-approval` (same run registry; saved-run recovery reads run logs).
      Runs don't stop without a viewer (`RunState::without_detach_timeout`); the budget is the tool-round ceiling and
      an hour of wall time. The log is `chats/<id>.run`: header, messages as sent (first time each is sent), tool sets
      by hash, request records written before sending (stage, depends-on, message count, tool set, other body
      fields), responses, stages, end with report and activity. The report request keeps the tools with
      `tool_choice: "none"`. A run is marked with `SearchFlags.ResearchRun` (0x001) on its query item: the item's
      existing flags, so no item format change or migration. Chat messages to a run's query item are refused; deleting
      the item or orphan cleanup removes the log. Not yet: HTTP routes exercised by hand; `tool_choice: "none"` checked
      against llama-server (does it keep tools in the rendered prompt?).
   2. **Done.** Runs in the UI. New Query's Deep research starts a run (`server.researchStream`); in an existing chat
      it still goes through the chat until step 4. Runs show binoculars in the Queries list (`isQueryResearchRun`, the
      item flag, set locally at once and by the server). The run view is the chat view with the input area's contents
      swapped, same geometry: stages (Research › Review › Report) in the profile row, a read-only status line and Stop
      in the input row, the setup read-only. Stages come from the load response and the stream's stage status texts.
      Checked in a browser against a fake model: start, running, done with title, reload, resume mid-run, stop. Not
      done: a running/finished status marker on list rows (only the icon); `Keep` of a run (step 3) is unhandled.
   3. **Actions on a finished run.** Keep (report as a document page with the run log attached), Chat about this
      report (new chat with it attached; needs "Chat about an item"), Run again (New Query filled with the same
      question and setup).
   4. **Deep research removed from chat.** The mode leaves the chat input and `ChatSetup`, with the deep-research
      prompts and code paths in chat.
   5. **Later:** `ask_user`, on the approval-pause mechanism.
3. **Done.** Fixed setup per chat. The first turn writes a `ChatSetup` into the transcript header: system prompt and
   tool definitions as sent, how each server tool is called, scope, scope items, capabilities, mode. Later turns send
   the stored prompt and tools, refuse other scope/tools/mode (`prepare_chat_resources`), and don't need tool servers
   to be reachable (calls to a missing one return a tool error). Continue copies the setup. The client gets it in the
   load response (`setup`) or from the first accepted turn; scope, tool sources, mode and profile application are then
   read-only, model/effort/approval stay editable; a missing tool source warns instead of blocking. Chats without a
   stored setup (older transcripts) keep the old behaviour. Still open: the deep-research report request sends no
   tools (goes with step 2); route and UI not yet exercised by hand.
4. Chat transcript redesign.
5. Chat about an item.

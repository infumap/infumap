// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Deep research runs. A run is an autonomous job, not a chat: a question and its inputs go in, a strategy runs, a
//! report comes out, and the run can't be continued. It lives on a query item in the Queries page, marked with
//! `RESEARCH_RUN_FLAG`, and runs in the background: unlike a chat turn, it doesn't stop when no one is watching.
//!
//! Its log, `user_{id}/chats/{query_item_id}.run`, records exactly what the model was given, in the chat transcript's
//! records (transcript.rs), as a chat of one turn: append-only JSONL, each record synced before the next step.
//! - The header: the question with its attachments, as the model got it; the setup every request sends (system
//!   prompt and tool definitions); the strategy; the server version.
//! - A record as each stage starts.
//! - Each model request before it is sent, its reply, and each message the run adds (tool results, stage
//!   instructions). Each message is stored once; the report is the last reply, and the activity shown is derived.
//! - The end: outcome, error, and the tool calls' display details.
//!
//! A request's body is rebuilt as a chat turn's is: the system prompt, the question, then what the run had added,
//! `messages` in all, with the setup's tools and the request's other fields.

use std::path::{Path, PathBuf};

use tokio::io::AsyncWriteExt;

use super::activity::{ActivityPhase, ActivitySnapshot};
use super::runs::{RunResult, RunSnapshot, RunState};
use super::transcript::{
  ChatSetup, EndRecord, MessageRecord, RequestRecord, ResponseRecord, TranscriptTurn, TurnEntry, TurnOutcome,
  UserRecord,
};
use super::*;

pub(super) const RUN_LOG_EXTENSION: &str = "run";
/// Version 2 stores the run in the chat transcript's records. Version 1 logs are not read: run logs are not kept
/// compatible across this change.
const RUN_LOG_VERSION: u32 = 2;
/// Marks a query item as a research run (`SearchFlags.ResearchRun` in the web client), so the Queries list can tell
/// runs from chats without reading their logs. A flag rather than a new field: query items already have flags, so
/// the item format doesn't change.
pub(super) const RESEARCH_RUN_FLAG: i64 = 0x001;
const STRATEGY_STANDARD: &str = "standard";
/// A run needs no viewer, so this and the tool-round ceiling are what stop one that has gone wrong.
const MAX_RUN_DURATION: Duration = Duration::from_secs(60 * 60);
/// A backstop against a model that loops forever, shared by all stages, so it is the ceiling for a whole run.
const RESEARCH_MAX_TOOL_ROUNDS: usize = 10_000;
const RESEARCH_REVIEW_PROMPT: &str = "\
Review the evidence collected so far. Check coverage of the user's question, source quality and recency, factual \
conflicts, and whether the main claims can be cited. If a material gap can be resolved with any available read-only \
discovery or retrieval tool, use it now. Tool names and domains vary, so rely on their descriptions. When the \
evidence is adequate or remaining gaps cannot be resolved, return a concise readiness memo describing the supported \
conclusions and any limitations. This is still not the final report.";
const RESEARCH_REPORT_PROMPT: &str = "\
Write the final deep-research report now. Use only the evidence already collected, and do not call any tool in \
this stage. Answer the user's question directly, distinguish facts from inference, explain material conflicts or \
limitations, and use exact Markdown links returned by tools for citations near the claims they support. Never invent \
a citation or imply that a search-result snippet was fully read. Prefer a clear structure suited to the question over \
a fixed template.";

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RunRecord {
  Header(RunHeader),
  Stage(StageRecord),
  Request(RequestRecord),
  Response(ResponseRecord),
  Message(MessageRecord),
  End(EndRecord),
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunHeader {
  version: u32,
  query_item_id: Uid,
  /// Identifies the run's live stream, for resume and stop, and its records.
  pub(super) request_id: String,
  pub(super) created_at: i64,
  server_version: String,
  pub(super) strategy: String,
  /// The question, its attachments (selected skills and items in scope included) and the settings chosen for it.
  pub(super) user: UserRecord,
  /// What every request sends: the system prompt and tool definitions, and how each tool is called.
  pub(super) setup: ChatSetup,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StageRecord {
  pub(super) name: String,
  pub(super) started_at: i64,
}

pub(super) fn run_log_path(data_dir: &str, user_id: &Uid, query_item_id: &Uid) -> InfuResult<PathBuf> {
  Ok(transcript::transcript_path(data_dir, user_id, query_item_id)?.with_extension(RUN_LOG_EXTENSION))
}

/// The writer. Only the run's worker holds one, under the chat lock.
struct RunLog {
  file: tokio::fs::File,
  request_id: String,
  /// The number of the last model request recorded, and whether its reply has been.
  last_request: Option<(usize, bool)>,
}

impl RunLog {
  /// Fails if the query item already has a run: a run is never restarted.
  async fn create(path: &Path, header: RunHeader) -> InfuResult<Self> {
    if let Some(dir) = path.parent() {
      tokio::fs::create_dir_all(dir).await?;
    }
    let file = tokio::fs::OpenOptions::new().create_new(true).append(true).open(path).await?;
    let request_id = header.request_id.clone();
    let mut log = Self { file, request_id, last_request: None };
    log.append(&RunRecord::Header(header)).await?;
    Ok(log)
  }

  async fn append(&mut self, record: &RunRecord) -> InfuResult<()> {
    let mut line = serde_json::to_string(record)?;
    line.push('\n');
    self.file.write_all(line.as_bytes()).await?;
    self.file.sync_data().await?;
    Ok(())
  }

  async fn stage(&mut self, name: &str) -> InfuResult<()> {
    self.append(&RunRecord::Stage(StageRecord { name: name.to_owned(), started_at: unix_now_millis() })).await
  }

  /// Records a model request before it is sent. Returns its number in the run.
  async fn request(
    &mut self,
    endpoint: &ChatEndpoint,
    payload: &OpenAiChatCompletionRequest,
    messages: usize,
  ) -> InfuResult<usize> {
    let number = self.last_request.map_or(1, |(number, _)| number + 1);
    let record = request_record(&self.request_id, number, endpoint, payload, messages)?;
    self.append(&RunRecord::Request(record)).await?;
    self.last_request = Some((number, false));
    Ok(number)
  }

  async fn response(&mut self, number: usize, result: &InfuResult<OpenAiChatMessage>) -> InfuResult<()> {
    self.append(&RunRecord::Response(response_record(&self.request_id, number, result))).await?;
    self.last_request = Some((number, true));
    Ok(())
  }

  /// Records a message the run added that isn't a model reply: a tool result, or a stage instruction.
  async fn message(&mut self, message: &OpenAiChatMessage) -> InfuResult<()> {
    let record = MessageRecord { request_id: self.request_id.clone(), message: ChatHistoryMessage::from_wire(message) };
    self.append(&RunRecord::Message(record)).await
  }

  /// Ends the run, keeping what had arrived of a reply it stopped or failed during (see `partial_response`).
  async fn end(
    &mut self,
    outcome: TurnOutcome,
    error: Option<String>,
    progress: &ChatProgressReporter,
  ) -> InfuResult<()> {
    let (rounds, context_tokens) = progress.activity.as_ref().map_or((vec![], None), |activity| {
      let activity = activity.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
      (activity.finished_rounds(), activity.context_tokens())
    });
    if let Some(partial) = partial_response(&self.request_id, outcome, self.last_request, &rounds) {
      self.append(&RunRecord::Response(partial)).await?;
    }
    self.append(&RunRecord::End(end_record(&self.request_id, outcome, error, rounds, context_tokens))).await
  }
}

/// A run as its log records it: the run is a chat turn of its own, with the stages it started.
pub(super) struct SavedRun {
  pub(super) header: RunHeader,
  pub(super) stages: Vec<StageRecord>,
  pub(super) turn: TranscriptTurn,
}

impl SavedRun {
  pub(super) fn end(&self) -> Option<&EndRecord> {
    self.turn.end.as_ref()
  }

  /// The report: the run's last reply, once it has completed.
  pub(super) fn report(&self) -> Option<String> {
    self.turn.assistant_text()
  }

  /// The run as a transcript of one turn, which rebuilds its requests (`Transcript::request_messages`). Only tests
  /// read it so far, as for chats.
  #[cfg_attr(not(test), allow(dead_code))]
  pub(super) fn transcript(&self) -> Transcript {
    let header = TranscriptHeader {
      version: transcript::TRANSCRIPT_FORMAT_VERSION,
      query_item_id: self.header.query_item_id.clone(),
      created_at: self.header.created_at,
      server_version: self.header.server_version.clone(),
      setup: Some(self.header.setup.clone()),
    };
    let turn =
      TranscriptTurn { user: self.turn.user.clone(), entries: self.turn.entries.clone(), end: self.turn.end.clone() };
    Transcript { header, turns: vec![turn] }
  }
}

pub(super) async fn read_run(data_dir: &str, user_id: &Uid, query_item_id: &Uid) -> InfuResult<Option<SavedRun>> {
  match tokio::fs::read(run_log_path(data_dir, user_id, query_item_id)?).await {
    Ok(bytes) => parse_run(&bytes),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(e.into()),
  }
}

/// The log's complete records, without reading them: an append still in progress is an incomplete last line, left out.
pub(super) async fn read_run_bytes(data_dir: &str, user_id: &Uid, query_item_id: &Uid) -> InfuResult<Option<Vec<u8>>> {
  match tokio::fs::read(run_log_path(data_dir, user_id, query_item_id)?).await {
    Ok(mut bytes) => {
      bytes.truncate(bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |index| index + 1));
      Ok(Some(bytes))
    }
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(e.into()),
  }
}

/// An incomplete last line, from an append cut short, is ignored.
pub(super) fn parse_run(bytes: &[u8]) -> InfuResult<Option<SavedRun>> {
  let complete = &bytes[..bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |index| index + 1)];
  let mut lines = complete.split(|byte| *byte == b'\n').filter(|line| !line.is_empty());
  let Some(first) = lines.next() else { return Ok(None) };
  let header: Value = serde_json::from_slice(first)?;
  let version = header.get("version").and_then(Value::as_u64).unwrap_or(0);
  if version != u64::from(RUN_LOG_VERSION) {
    return Err(format!("This research run was saved in run log format {version}, which can't be read.").into());
  }
  let RunRecord::Header(header) = serde_json::from_value(header)? else {
    return Err("A research run log must start with its header.".into());
  };
  let turn = TranscriptTurn { user: header.user.clone(), entries: vec![], end: None };
  let mut run = SavedRun { header, stages: vec![], turn };
  for line in lines {
    match serde_json::from_slice(line)? {
      RunRecord::Header(_) => return Err("A research run log has a second header.".into()),
      RunRecord::Stage(stage) => run.stages.push(stage),
      RunRecord::Request(request) => run.turn.entries.push(TurnEntry::Request(request)),
      RunRecord::Response(response) => run.turn.entries.push(TurnEntry::Response(response)),
      RunRecord::Message(message) => run.turn.entries.push(TurnEntry::Message(message)),
      RunRecord::End(end) => run.turn.end = Some(end),
    }
  }
  Ok(Some(run))
}

/// The run as a resume or stop sees it once its worker has gone.
pub(super) fn snapshot(owner_id: &Uid, run: &SavedRun) -> RunSnapshot {
  let end = run.end();
  let (phase, status_text) = match end.map(|end| end.outcome) {
    Some(TurnOutcome::Completed) => (ActivityPhase::Complete, "Research complete"),
    Some(TurnOutcome::Cancelled) => (ActivityPhase::Cancelled, "Research stopped"),
    Some(TurnOutcome::Error) => (ActivityPhase::Error, "Research failed"),
    None => (ActivityPhase::Interrupted, "Research interrupted"),
  };
  let result = run.report().map(|text| {
    let items = chat_response_items_json(owner_id, &text).get("items").cloned().unwrap_or_else(|| Value::Array(vec![]));
    RunResult { text, items }
  });
  let rounds = run.turn.rounds();
  RunSnapshot {
    revision: 1,
    resolved_attachments: LoadChatAttachment::resolved(&run.header.user.attachments),
    started_at: run.header.created_at,
    ended_at: end.map(|end| end.ended_at),
    activity: ActivitySnapshot {
      phase,
      status_text: status_text.to_owned(),
      answer_preview: result
        .as_ref()
        .map(|result| result.text.clone())
        .or_else(|| rounds.last().map(|round| round.answer.clone()))
        .unwrap_or_default(),
      rounds,
      context_tokens: end.and_then(|end| end.context_tokens),
    },
    pending_approvals: vec![],
    cancellation_requested: false,
    error_message: end
      .and_then(|end| end.error.clone())
      .or_else(|| end.is_none().then(|| "The server stopped before this research run finished.".to_owned())),
    result,
  }
}

/// POST, a chat request body: starts a research run on a fresh query item in the Queries page, and returns its live
/// stream, which a viewer may leave at any time. `mode` is ignored. A retry with the same request ID attaches to
/// the run rather than starting another.
pub async fn serve_research_start_route(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  request: Request<hyper::body::Incoming>,
) -> Response<BoxBody<Bytes, hyper::Error>> {
  if request.method() == "OPTIONS" {
    return cors_response();
  }
  let Some(session) = get_and_validate_session(&request, db).await else {
    return single_chat_stream_event_response(
      new_chat_request_id(),
      ChatStreamEventKind::error("Session is required to start research."),
    );
  };
  let request: ChatRequest = match incoming_json_with_limit(request, COMMAND_REQUEST_MAX_BYTES).await {
    Ok(request) => request,
    Err(e) => {
      warn!("Could not parse a research request for user '{}': {}", session.user_id, e);
      return single_chat_stream_event_response(
        new_chat_request_id(),
        ChatStreamEventKind::error("Could not parse the research request."),
      );
    }
  };
  let request_id = request.stream_request_id(new_chat_request_id());
  match start_research_run(config, db, &session, request, &request_id).await {
    Ok(subscriber) => chat_stream_response(subscriber),
    Err(event) => single_chat_stream_event_response(request_id, event),
  }
}

pub(super) async fn start_research_run(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  mut request: ChatRequest,
  request_id: &str,
) -> Result<runs::RunSubscriber, ChatStreamEventKind> {
  let error = |message: &str| ChatStreamEventKind::error(message);
  let query_item_id = request.query_item_id.clone().ok_or_else(|| error("A research run needs a query item."))?;
  let reservation = runs::reserve_start(&session.user_id, &query_item_id, request_id).await;
  let data_dir = live_chat_data_dir(db, session, &query_item_id).await.map_err(|e| error(&e.message()))?;
  if let Some(run) = runs::find(&session.user_id, &query_item_id, request_id)
    && let Some(subscriber) = run.subscribe()
  {
    return Ok(subscriber);
  }
  let log_error = |e: infusdk::util::infu::InfuError| {
    warn!("Could not use the research log of '{}' for user '{}': {}", query_item_id, session.user_id, e);
    error("Could not read or write the research run.")
  };
  if let Some(run) = read_run(&data_dir, &session.user_id, &query_item_id).await.map_err(log_error)? {
    return Err(if run.header.request_id == request_id {
      ChatStreamEventKind::Snapshot { snapshot: snapshot(&session.user_id, &run) }
    } else {
      error("This query already has a research run. Start research from New Query.")
    });
  }
  if read_transcript(&data_dir, &session.user_id, &query_item_id).await.map_err(log_error)?.is_some() {
    return Err(error("This query is a chat. Start research from New Query."));
  }
  request.settings.mode = ChatRunMode::DeepResearch;
  request.settings.normalize().map_err(|e| error(e.message()))?;
  let resources =
    prepare_chat_resources(config.as_ref(), db, session, &request, None).await.map_err(|message| error(&message))?;
  let lock = transcript::try_lock_chat(&session.user_id, &query_item_id)
    .ok_or_else(|| error("This query is busy. Try again."))?;

  let text = request.text.as_deref().map(str::trim).unwrap_or("").to_owned();
  let attachments = chat_attachments_from_request(std::mem::take(&mut request.attachments)).map_err(|e| error(&e))?;
  if text.is_empty() && attachments.is_empty() && !request.has_skills() {
    return Err(error("Ask a question to research."));
  }
  let scope = resources.infumap_data.as_ref().and_then(InfumapData::scope);
  let attachments = message_attachments(db, session, &request, &text, attachments, scope, None).await?;
  let started_at = unix_now_millis();
  let user = UserRecord::new(request_id.to_owned(), started_at, text, attachments, request.settings.clone());
  let setup = first_turn_chat_setup(&*db.lock().await, &request, &resources, started_at);
  let header = RunHeader {
    version: RUN_LOG_VERSION,
    query_item_id: query_item_id.clone(),
    request_id: request_id.to_owned(),
    created_at: started_at,
    server_version: env!("CARGO_PKG_VERSION").to_owned(),
    strategy: STRATEGY_STANDARD.to_owned(),
    user: user.clone(),
    setup: setup.clone(),
  };
  let path = run_log_path(&data_dir, &session.user_id, &query_item_id).map_err(log_error)?;
  let log = RunLog::create(&path, header).await.map_err(log_error)?;
  if let Err(e) = super::super::item_ops::set_item_flags(db, &session.user_id, &query_item_id, RESEARCH_RUN_FLAG).await
  {
    warn!("Could not mark query item '{}' as a research run: {}", query_item_id, e);
  }

  let resolved = LoadChatAttachment::resolved(&user.attachments);
  let state = Arc::new(Mutex::new(RunState::new(1, started_at, resolved).without_detach_timeout()));
  let (registration, subscriber) =
    runs::register(session.user_id.clone(), query_item_id.clone(), request_id.to_owned(), state.clone())
      .map_err(error)?;
  let progress = ChatProgressReporter::for_live_run(request_id.to_owned(), query_item_id.clone(), state);
  let run = Run { query_item_id, user, system_prompt: setup.system_prompt, resources };
  tokio::spawn(run_worker(config, db.clone(), session.clone(), run, log, lock, registration, progress));
  // Retries can attach from here on; inference must not hold the startup lock.
  drop(reservation);
  Ok(subscriber)
}

/// The query item, the question, and the prepared system prompt, model and tools.
struct Run {
  query_item_id: Uid,
  user: UserRecord,
  system_prompt: String,
  resources: ChatResources,
}

enum RunStop {
  Cancelled,
  TimedOut,
  Failed(infusdk::util::infu::InfuError),
}

#[allow(clippy::too_many_arguments)]
async fn run_worker(
  config: Arc<Config>,
  db: Arc<tokio::sync::Mutex<Db>>,
  session: Session,
  run: Run,
  mut log: RunLog,
  _lock: tokio::sync::OwnedMutexGuard<()>,
  registration: runs::RunRegistration,
  progress: ChatProgressReporter,
) {
  let user_id = session.user_id.clone();
  let outcome = AssertUnwindSafe(async {
    let scope_attachments = run
      .user
      .attachments
      .iter()
      .filter(|attachment| attachment.item_id.is_some())
      .map(LoadChatAttachment::from)
      .collect();
    progress.send(ChatStreamEventKind::TurnAccepted { revision: 1, scope_attachments }).await;
    let result = tokio::select! {
      _ = registration.run.cancelled() => Err(RunStop::Cancelled),
      _ = tokio::time::sleep(MAX_RUN_DURATION) => Err(RunStop::TimedOut),
      result = run_standard_strategy(&config, &db, &session, run, &mut log, &progress) => {
        result.map_err(RunStop::Failed)
      }
    };
    cancel_pending_tool_approvals(&progress.request_id, &user_id);
    let (outcome, error, event) = match result {
      Ok(report) => {
        let items = chat_response_items_json(&user_id, &report).get("items").cloned().unwrap_or(Value::Array(vec![]));
        (TurnOutcome::Completed, None, ChatStreamEventKind::final_items(items, &report, vec![]))
      }
      Err(RunStop::Cancelled) => (TurnOutcome::Cancelled, None, ChatStreamEventKind::Cancelled),
      Err(RunStop::TimedOut) => {
        let message = "The research run stopped after an hour.";
        (TurnOutcome::Error, Some(message.to_owned()), ChatStreamEventKind::error(message))
      }
      Err(RunStop::Failed(e)) => {
        warn!("Research run '{}' for user '{}' failed: {}", progress.request_id, user_id, e);
        let message = chat_failure_message(e.message());
        (TurnOutcome::Error, Some(message.clone()), ChatStreamEventKind::error(&message))
      }
    };
    // The end is saved before it is reported, so a resume never sees a finished run without its record.
    if let Err(e) = log.end(outcome, error, &progress).await {
      warn!("Could not record the end of research run '{}' for user '{}': {}", progress.request_id, user_id, e);
    }
    progress.send(event).await;
  })
  .catch_unwind()
  .await;
  if outcome.is_err() {
    error!("Research worker '{}' for user '{}' panicked.", progress.request_id, user_id);
    cancel_pending_tool_approvals(&progress.request_id, &user_id);
    let message = "The research worker stopped unexpectedly.";
    if let Err(e) = log.end(TurnOutcome::Error, Some(message.to_owned()), &progress).await {
      warn!("Could not record the failure of research run '{}': {}", progress.request_id, e);
    }
    progress.send(ChatStreamEventKind::error(message)).await;
  }
  drop(registration);
}

/// One model request of a run, recorded before it is sent and its reply after.
#[allow(clippy::too_many_arguments)]
async fn research_round(
  endpoint: &ChatEndpoint,
  messages: &[OpenAiChatMessage],
  tools: &[OpenAiToolSpec],
  tool_choice: Option<&'static str>,
  tool_rounds_completed: usize,
  log: &mut RunLog,
  progress: &ChatProgressReporter,
) -> InfuResult<CompletedChatModelRound> {
  let payload = chat_completion_payload(endpoint, messages, tools, tool_choice);
  let round = log.request(endpoint, &payload, messages.len()).await?;
  progress.model_round_started(round).await;
  let result = send_chat_completion(endpoint, &payload, round, progress).await;
  log.response(round, &result).await?;
  completed_model_round(endpoint, result?, round, tool_rounds_completed)
}

/// Adds messages to what the next request sends, recording each as it is added.
async fn add_messages(
  messages: &mut Vec<OpenAiChatMessage>,
  added: Vec<OpenAiChatMessage>,
  log: &mut RunLog,
) -> InfuResult<()> {
  for message in &added {
    log.message(message).await?;
  }
  messages.extend(added);
  Ok(())
}

/// The first strategy: research with tools, review the evidence (more tools allowed), then write the report.
/// Every request extends the one before it, so the provider's prompt cache covers the run: stage instructions are
/// appended, and the report request keeps the tool definitions, with `tool_choice: "none"` asking for no calls.
async fn run_standard_strategy(
  config: &Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  run: Run,
  log: &mut RunLog,
  progress: &ChatProgressReporter,
) -> InfuResult<String> {
  let Run { query_item_id, user, system_prompt, resources } = run;
  let mode = ChatRunMode::DeepResearch;
  let mut messages =
    vec![OpenAiChatMessage::text("system", system_prompt), OpenAiChatMessage::text("user", user.model_content())];
  generate_initial_chat_title(db, &session.user_id, &query_item_id, &user, &resources, &messages, progress).await;
  let ChatResources { endpoint, infumap_data, tools, name_map, approval_required } = resources;
  let tool_context = ChatToolContext { mode, model: endpoint.model.clone(), call_counts: Mutex::new(HashMap::new()) };
  let mut tool_rounds = 0usize;

  let stages =
    [("research", "Researching sources", None), ("review", "Reviewing evidence", Some(RESEARCH_REVIEW_PROMPT))];
  for (stage, status, instruction) in stages {
    log.stage(stage).await?;
    progress.status(status).await;
    if let Some(instruction) = instruction {
      add_messages(&mut messages, vec![OpenAiChatMessage::text("system", instruction.to_owned())], log).await?;
    }
    loop {
      let completed = research_round(&endpoint, &messages, &tools, None, tool_rounds, log, progress).await?;
      // The reply is recorded as the request's response, so it isn't recorded again as an added message.
      messages.push(completed.assistant_message);
      if completed.tool_calls.is_empty() {
        break;
      }
      if tool_rounds >= RESEARCH_MAX_TOOL_ROUNDS {
        return Err(format!("Chat tool loop exceeded maximum tool rounds ({RESEARCH_MAX_TOOL_ROUNDS}).").into());
      }
      tool_rounds += 1;
      let tool_messages = execute_chat_tool_round(
        db,
        session,
        config.as_ref(),
        infumap_data.as_ref(),
        &name_map,
        &approval_required,
        completed.number,
        completed.tool_calls,
        &tool_context,
        progress,
      )
      .await?;
      add_messages(&mut messages, tool_messages, log).await?;
    }
  }

  log.stage("report").await?;
  progress.status("Writing research report").await;
  add_messages(&mut messages, vec![OpenAiChatMessage::text("system", RESEARCH_REPORT_PROMPT.to_owned())], log).await?;
  let tool_choice = (!tools.is_empty()).then_some("none");
  let completed = research_round(&endpoint, &messages, &tools, tool_choice, tool_rounds, log, progress).await?;
  if !completed.tool_calls.is_empty() {
    return Err(format!("{} attempted to call a tool while writing the final research report.", endpoint.label).into());
  }
  let report = completed.assistant_message.content.unwrap_or_default();
  if report.trim().is_empty() {
    return Err(format!("{} returned an empty research report.", endpoint.label).into());
  }
  Ok(report)
}

/// What a research run adds to its `load-chat` response.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LoadResearch {
  strategy: String,
  stages: Vec<StageRecord>,
}

/// A run in the shape of a chat of one turn: the question, then the report. The chat view then shows it, follows it
/// with `/chat/resume` and stops it with `/chat/cancel`, as it does a chat's running turn. `running` is whether its
/// worker still holds the chat lock.
pub(super) fn load_chat_response(owner_id: &Uid, run: SavedRun, running: bool) -> LoadChatResponse {
  let end = run.end();
  let status = match end.map(|end| end.outcome) {
    Some(TurnOutcome::Completed) => TurnStatus::Completed,
    Some(TurnOutcome::Cancelled) => TurnStatus::Cancelled,
    Some(TurnOutcome::Error) => TurnStatus::Error,
    None if running => TurnStatus::Running,
    None => TurnStatus::Interrupted,
  };
  let report = run.report();
  let items = report.as_deref().map(|report| {
    chat_response_items_json(owner_id, report).get("items").cloned().unwrap_or_else(|| Value::Array(vec![]))
  });
  let user = &run.header.user;
  let settings = &user.settings;
  let turn = LoadChatTurn {
    request_id: run.header.request_id.clone(),
    text: user.text.clone(),
    status,
    started_at: run.header.created_at,
    ended_at: end.map(|end| end.ended_at),
    error: end.and_then(|end| end.error.clone()),
    attachments: user.attachments.iter().filter(|attachment| !attachment.is_inline_skill()).map(Into::into).collect(),
    assistant_text: report,
    items,
    rounds: run.turn.rounds(),
  };
  LoadChatResponse {
    revision: 1,
    running,
    last_settings: Some(settings.clone()),
    context_tokens: end.and_then(|end| end.context_tokens),
    setup: Some(LoadChatSetup {
      scope: settings.configuration.scope.clone(),
      scope_item_ids: settings.scope_item_ids.clone(),
      capabilities: settings.configuration.capabilities.clone(),
      mode: settings.mode,
    }),
    turns: vec![turn],
    research: Some(LoadResearch { strategy: run.header.strategy.clone(), stages: run.stages.clone() }),
  }
}

pub(super) use crate::util::mime::RESEARCH_RUN_MIME_TYPE;

/// Keeps a finished run in the item tree where it was dropped, as a run: a `.run` item holding its log, which opens
/// as the run did, as a `.chat` item does a chat. The query item and the log in the data directory are then removed,
/// as when a chat is kept. A run without a report has nothing to keep.
pub(super) async fn persist_research_run(
  config: &Config,
  db: &Arc<tokio::sync::Mutex<Db>>,
  object_store: Arc<object::ObjectStore>,
  image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
  session: &Session,
  request: &ChatPersistRequest,
  data_dir: &str,
) -> InfuResult<String> {
  let query_item_id = &request.query_item_id;
  let user_id = &session.user_id;
  {
    let db = db.lock().await;
    if !super::super::is_unpinned(db.item.get(query_item_id)?) {
      return Err("Only an earlier research run can be moved out of the Queries page.".into());
    }
  }
  let path = run_log_path(data_dir, user_id, query_item_id)?;
  {
    let _lock = transcript::try_lock_chat(user_id, query_item_id)
      .ok_or("This research run is still running. Keep it when it has finished.")?;
    let run = parse_run(&tokio::fs::read(&path).await?)?.ok_or("The research run was not found.")?;
    if run.report().is_none() {
      return Err("This research run has no report to keep. Delete it instead.".into());
    }
  }
  // Fill in a missing title from an earlier run or a failed initial title request.
  let title = match generate_live_chat_title(config, db, session, query_item_id).await {
    Ok(title) if !title.trim().is_empty() => title,
    Ok(_) => "Research".to_owned(),
    Err(e) => {
      warn!("Could not get a title for research run '{}' while keeping it: {}", query_item_id, e);
      let current = db.lock().await.item.get(query_item_id)?.title.clone().unwrap_or_default();
      if current.trim().is_empty() { "Research".to_owned() } else { current }
    }
  };
  let lock = transcript::try_lock_chat(user_id, query_item_id).ok_or("The research run is busy. Try again.")?;
  let log = tokio::fs::read(&path).await?;

  let mut item_map = request.item.clone();
  item_map.insert("id".to_owned(), Value::String(new_uid()));
  item_map.insert("itemType".to_owned(), Value::String(ItemType::Text.as_str().to_owned()));
  item_map.insert("ownerId".to_owned(), Value::String(user_id.clone()));
  item_map.insert("title".to_owned(), Value::String(format!("{title}.run")));
  item_map.insert("fileSizeBytes".to_owned(), Value::Number(log.len().into()));
  item_map.remove("mimeType");
  let added = super::super::item_ops::add_item_for_user_with_mime_type(
    db,
    object_store.clone(),
    &serde_json::to_string(&Value::Object(item_map))?,
    &Some(general_purpose::STANDARD.encode(&log)),
    user_id,
    Some(RESEARCH_RUN_MIME_TYPE),
  )
  .await?
  .ok_or("Adding the research run item returned nothing.")?;

  // The log is kept while this holds the chat lock, so deleting the query item leaves it for us to remove.
  let delete_json = serde_json::json!({ "id": query_item_id }).to_string();
  if let Err(e) =
    super::super::item_ops::handle_delete_item(db, object_store, image_cache, &delete_json, &Some(session.clone()))
      .await
  {
    warn!("Kept research run '{}', but could not delete its query item, so both remain: {}", query_item_id, e);
  } else if let Err(e) = tokio::fs::remove_file(&path).await {
    warn!("Kept research run '{}', but could not remove its log; startup cleanup will: {}", query_item_id, e);
  }
  drop(lock);
  Ok(added)
}

/// A kept run's log, from its `.run` item. None if the item is not a kept run.
pub(super) async fn read_kept_run(
  db: &Arc<tokio::sync::Mutex<Db>>,
  object_store: Arc<object::ObjectStore>,
  session: &Session,
  item_id: &Uid,
) -> InfuResult<Option<(SavedRun, Vec<u8>)>> {
  let encryption_key = {
    let db = db.lock().await;
    let item = db.item.get(item_id)?;
    if item.owner_id != session.user_id
      || item.item_type != ItemType::Text
      || item.mime_type.as_deref() != Some(RESEARCH_RUN_MIME_TYPE)
    {
      return Ok(None);
    }
    db.user.get(&session.user_id).ok_or("The user was not found.")?.object_encryption_key.clone()
  };
  let bytes = object::get(object_store, session.user_id.clone(), item_id.clone(), &encryption_key).await?;
  let run = parse_run(&bytes)?.ok_or_else(|| format!("Research run item '{}' has no log.", item_id))?;
  Ok(Some((run, bytes)))
}

/// Writes a kept run's log under a new query item's id, for moving it back to the Queries page as the run it was.
/// The caller adds the query item, marked as a run.
pub(super) async fn restore_kept_run(
  session: &Session,
  data_dir: &str,
  query_item_id: &Uid,
  log: &[u8],
) -> InfuResult<()> {
  let text = std::str::from_utf8(log).map_err(|_| "The research run log is not text.")?;
  let (first, rest) = text.split_once('\n').ok_or("The research run log has no header.")?;
  let mut header: Value = serde_json::from_str(first)?;
  header["queryItemId"] = Value::String(query_item_id.clone());
  let mut content = serde_json::to_string(&header)?;
  content.push('\n');
  content.push_str(rest);
  parse_run(content.as_bytes())?.ok_or("The research run log has no header.")?;
  let path = run_log_path(data_dir, &session.user_id, query_item_id)?;
  if let Some(dir) = path.parent() {
    tokio::fs::create_dir_all(dir).await?;
  }
  crate::ai::artifact_io::atomic_write(&path, content.as_bytes()).await
}

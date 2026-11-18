// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Deep research runs. A run is an autonomous job, not a chat: a question and its inputs go in, a strategy runs, a
//! report comes out, and the run can't be continued. It lives on a query item in the Queries page, marked with
//! `RESEARCH_RUN_FLAG`, and runs in the background: unlike a chat turn, it doesn't stop when no one is watching.
//!
//! Its log, `user_{id}/chats/{query_item_id}.run`, records exactly what the model was given. It is append-only JSONL,
//! each record synced before the next step:
//! - the header: the question, its attachments and setup, the strategy and the server version;
//! - each message the first time a request sends it, as sent (the form the provider gets, not the internal one);
//! - each tool set once, by hash, with how its tools are called;
//! - each request before it is sent: its stage, the requests it followed, how many messages it sent, its tool set
//!   and every other field of the body. The body is those fields, those messages and that tool set;
//! - each response as received, stages as they start, and the end with the report and the activity shown for it.
//!
//! Requests are numbered and say which earlier requests they followed, and messages belong to a branch, so a strategy
//! that runs several models side by side can use the same log. The only strategy today is one branch.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::activity::{ActivityPhase, ActivitySnapshot};
use super::mcp::MappedMcpToolTarget;
use super::runs::{RunResult, RunSnapshot, RunState};
use super::transcript::{ActivityRound, ContextTokenCount, TurnOutcome, UserRecord};
use super::*;

pub(super) const RUN_LOG_EXTENSION: &str = "run";
const RUN_LOG_VERSION: u32 = 1;
/// Marks a query item as a research run (`SearchFlags.ResearchRun` in the web client), so the Queries list can tell
/// runs from chats without reading their logs. A flag rather than a new field: query items already have flags, so
/// the item format doesn't change.
pub(super) const RESEARCH_RUN_FLAG: i64 = 0x001;
const STRATEGY_STANDARD: &str = "standard";
const MAIN_BRANCH: usize = 0;
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
  ToolSet(ToolSetRecord),
  Message(MessageRecord),
  Request(RequestRecord),
  Response(ResponseRecord),
  Stage(StageRecord),
  End(EndRecord),
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunHeader {
  version: u32,
  query_item_id: Uid,
  /// Identifies the run's live stream, for resume and stop.
  pub(super) request_id: String,
  pub(super) created_at: i64,
  server_version: String,
  pub(super) strategy: String,
  /// The question, its attachments (selected skills and items in scope included) and the setup chosen for it.
  pub(super) user: UserRecord,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolSetRecord {
  hash: String,
  tools: Vec<OpenAiToolSpec>,
  /// How each tool from a tool server is called, by name.
  targets: BTreeMap<String, MappedMcpToolTarget>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageRecord {
  branch: usize,
  index: usize,
  message: OpenAiChatMessage,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestRecord {
  id: usize,
  branch: usize,
  stage: String,
  /// The requests whose results this one was built on.
  depends_on: Vec<usize>,
  /// It sent the branch's first `messages` messages.
  messages: usize,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  tool_set: Option<String>,
  /// Every other field of the request body, as sent.
  params: Value,
  started_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseRecord {
  request: usize,
  ended_at: i64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  message: Option<OpenAiChatMessage>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  error: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StageRecord {
  pub(super) name: String,
  pub(super) started_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EndRecord {
  pub(super) outcome: TurnOutcome,
  pub(super) ended_at: i64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub(super) error: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub(super) report: Option<String>,
  /// The activity shown for the run, including partial rounds of one that didn't complete.
  #[serde(default)]
  pub(super) rounds: Vec<ActivityRound>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub(super) context_tokens: Option<ContextTokenCount>,
}

pub(super) fn run_log_path(data_dir: &str, user_id: &Uid, query_item_id: &Uid) -> InfuResult<PathBuf> {
  Ok(transcript::transcript_path(data_dir, user_id, query_item_id)?.with_extension(RUN_LOG_EXTENSION))
}

fn tool_set_hash(tools: &[OpenAiToolSpec]) -> InfuResult<String> {
  let digest = Sha256::digest(serde_json::to_string(tools)?.as_bytes());
  Ok(digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect())
}

/// The writer. Only the run's worker holds one, under the chat lock.
struct RunLog {
  file: tokio::fs::File,
  /// How many messages of the branch are in the log.
  messages_logged: usize,
  tool_sets: HashSet<String>,
  next_request: usize,
  last_request: Option<usize>,
}

impl RunLog {
  /// Fails if the query item already has a run: a run is never restarted.
  async fn create(path: &Path, header: RunHeader) -> InfuResult<Self> {
    if let Some(dir) = path.parent() {
      tokio::fs::create_dir_all(dir).await?;
    }
    let file = tokio::fs::OpenOptions::new().create_new(true).append(true).open(path).await?;
    let mut log = Self { file, messages_logged: 0, tool_sets: HashSet::new(), next_request: 1, last_request: None };
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

  /// Records a request before it is sent: the messages it sends that the log doesn't have yet, its tool set if new,
  /// then the request. Returns its number.
  async fn request(
    &mut self,
    stage: &str,
    payload: &OpenAiChatCompletionRequest,
    targets: &BTreeMap<String, MappedMcpToolTarget>,
  ) -> InfuResult<usize> {
    for (index, message) in payload.messages.iter().enumerate().skip(self.messages_logged) {
      let record = MessageRecord { branch: MAIN_BRANCH, index, message: message.clone() };
      self.append(&RunRecord::Message(record)).await?;
    }
    self.messages_logged = self.messages_logged.max(payload.messages.len());
    let tool_set = if payload.tools.is_empty() { None } else { Some(tool_set_hash(&payload.tools)?) };
    if let Some(hash) = tool_set.as_ref().filter(|hash| !self.tool_sets.contains(*hash)) {
      let record = ToolSetRecord { hash: hash.clone(), tools: payload.tools.clone(), targets: targets.clone() };
      self.append(&RunRecord::ToolSet(record)).await?;
      self.tool_sets.insert(hash.clone());
    }
    let mut params = serde_json::to_value(payload)?;
    if let Some(params) = params.as_object_mut() {
      params.remove("messages");
      params.remove("tools");
    }
    let id = self.next_request;
    self.next_request += 1;
    let record = RequestRecord {
      id,
      branch: MAIN_BRANCH,
      stage: stage.to_owned(),
      depends_on: self.last_request.into_iter().collect(),
      messages: payload.messages.len(),
      tool_set,
      params,
      started_at: unix_now_millis(),
    };
    self.append(&RunRecord::Request(record)).await?;
    self.last_request = Some(id);
    Ok(id)
  }

  async fn response(&mut self, request: usize, result: &InfuResult<OpenAiChatMessage>) -> InfuResult<()> {
    let (message, error) = match result {
      Ok(message) => (Some(message.clone()), None),
      Err(error) => (None, Some(error.message().to_owned())),
    };
    self.append(&RunRecord::Response(ResponseRecord { request, ended_at: unix_now_millis(), message, error })).await
  }
}

/// What the run view needs from a log: the parts that aren't the model's input.
pub(super) struct SavedRun {
  pub(super) header: RunHeader,
  pub(super) stages: Vec<StageRecord>,
  pub(super) end: Option<EndRecord>,
}

pub(super) async fn read_run(data_dir: &str, user_id: &Uid, query_item_id: &Uid) -> InfuResult<Option<SavedRun>> {
  match tokio::fs::read(run_log_path(data_dir, user_id, query_item_id)?).await {
    Ok(bytes) => parse_run(&bytes),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(e.into()),
  }
}

/// An incomplete last line, from an append cut short, is ignored.
fn parse_run(bytes: &[u8]) -> InfuResult<Option<SavedRun>> {
  let complete = &bytes[..bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |index| index + 1)];
  let mut lines = complete.split(|byte| *byte == b'\n').filter(|line| !line.is_empty());
  let Some(first) = lines.next() else { return Ok(None) };
  let RunRecord::Header(header) = serde_json::from_slice(first)? else {
    return Err("A research run log must start with its header.".into());
  };
  let mut run = SavedRun { header, stages: vec![], end: None };
  for line in lines {
    match serde_json::from_slice(line)? {
      RunRecord::Stage(stage) => run.stages.push(stage),
      RunRecord::End(end) => run.end = Some(end),
      _ => {}
    }
  }
  Ok(Some(run))
}

/// The run as a resume or stop sees it once its worker has gone.
pub(super) fn snapshot(owner_id: &Uid, run: &SavedRun) -> RunSnapshot {
  let end = run.end.as_ref();
  let (phase, status_text) = match end.map(|end| end.outcome) {
    Some(TurnOutcome::Completed) => (ActivityPhase::Complete, "Research complete"),
    Some(TurnOutcome::Cancelled) => (ActivityPhase::Cancelled, "Research stopped"),
    Some(TurnOutcome::Error) => (ActivityPhase::Error, "Research failed"),
    None => (ActivityPhase::Interrupted, "Research interrupted"),
  };
  let result = end.and_then(|end| end.report.clone()).map(|text| {
    let items = chat_response_items_json(owner_id, &text).get("items").cloned().unwrap_or_else(|| Value::Array(vec![]));
    RunResult { text, items }
  });
  let rounds = end.map(|end| end.rounds.clone()).unwrap_or_default();
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
  let header = RunHeader {
    version: RUN_LOG_VERSION,
    query_item_id: query_item_id.clone(),
    request_id: request_id.to_owned(),
    created_at: started_at,
    server_version: env!("CARGO_PKG_VERSION").to_owned(),
    strategy: STRATEGY_STANDARD.to_owned(),
    user: user.clone(),
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
  let progress = ChatProgressReporter::for_live_run(request_id.to_owned(), query_item_id, state);
  tokio::spawn(run_worker(config, db.clone(), session.clone(), user, resources, log, lock, registration, progress));
  // Retries can attach from here on; inference must not hold the startup lock.
  drop(reservation);
  Ok(subscriber)
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
  user: UserRecord,
  resources: ChatResources,
  mut log: RunLog,
  _lock: tokio::sync::OwnedMutexGuard<()>,
  registration: runs::RunRegistration,
  progress: ChatProgressReporter,
) {
  let user_id = session.user_id.clone();
  let outcome = AssertUnwindSafe(async {
    let scope_attachments =
      user.attachments.iter().filter(|attachment| attachment.item_id.is_some()).map(LoadChatAttachment::from).collect();
    progress.send(ChatStreamEventKind::TurnAccepted { revision: 1, scope_attachments }).await;
    let result = tokio::select! {
      _ = registration.run.cancelled() => Err(RunStop::Cancelled),
      _ = tokio::time::sleep(MAX_RUN_DURATION) => Err(RunStop::TimedOut),
      result = run_standard_strategy(&config, &db, &session, &user, resources, &mut log, &progress) => {
        result.map_err(RunStop::Failed)
      }
    };
    cancel_pending_tool_approvals(&progress.request_id, &user_id);
    let (outcome, report, error, event) = match result {
      Ok(report) => {
        let items = chat_response_items_json(&user_id, &report).get("items").cloned().unwrap_or(Value::Array(vec![]));
        let event = ChatStreamEventKind::final_items(items, &report, vec![]);
        (TurnOutcome::Completed, Some(report), None, event)
      }
      Err(RunStop::Cancelled) => (TurnOutcome::Cancelled, None, None, ChatStreamEventKind::Cancelled),
      Err(RunStop::TimedOut) => {
        let message = "The research run stopped after an hour.";
        (TurnOutcome::Error, None, Some(message.to_owned()), ChatStreamEventKind::error(message))
      }
      Err(RunStop::Failed(e)) => {
        warn!("Research run '{}' for user '{}' failed: {}", progress.request_id, user_id, e);
        let message = chat_failure_message(e.message());
        (TurnOutcome::Error, None, Some(message.clone()), ChatStreamEventKind::error(&message))
      }
    };
    // The end is saved before it is reported, so a resume never sees a finished run without its record.
    if let Err(e) = end_run(&mut log, &progress, outcome, report, error).await {
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
    if let Err(e) = end_run(&mut log, &progress, TurnOutcome::Error, None, Some(message.to_owned())).await {
      warn!("Could not record the failure of research run '{}': {}", progress.request_id, e);
    }
    progress.send(ChatStreamEventKind::error(message)).await;
  }
  drop(registration);
}

async fn end_run(
  log: &mut RunLog,
  progress: &ChatProgressReporter,
  outcome: TurnOutcome,
  report: Option<String>,
  error: Option<String>,
) -> InfuResult<()> {
  let (rounds, context_tokens) = progress.activity.as_ref().map_or((vec![], None), |activity| {
    let activity = activity.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    (activity.finished_rounds(), activity.context_tokens())
  });
  let end = EndRecord { outcome, ended_at: unix_now_millis(), error, report, rounds, context_tokens };
  log.append(&RunRecord::End(end)).await
}

/// One model request of a run, recorded before it is sent and its response after.
#[allow(clippy::too_many_arguments)]
async fn research_round(
  endpoint: &ChatEndpoint,
  messages: &[OpenAiChatMessage],
  tools: &[OpenAiToolSpec],
  tool_choice: Option<&'static str>,
  round: usize,
  tool_rounds_completed: usize,
  stage: &str,
  targets: &BTreeMap<String, MappedMcpToolTarget>,
  log: &mut RunLog,
  progress: &ChatProgressReporter,
) -> InfuResult<CompletedChatModelRound> {
  let payload = chat_completion_payload(endpoint, messages, tools, tool_choice);
  let request = log.request(stage, &payload, targets).await?;
  progress.model_round_started(round).await;
  let result = send_chat_completion(endpoint, &payload, round, progress).await;
  log.response(request, &result).await?;
  completed_model_round(endpoint, result?, round, tool_rounds_completed)
}

/// The first strategy: research with tools, review the evidence (more tools allowed), then write the report.
/// Every request extends the one before it, so the provider's prompt cache covers the run: stage instructions are
/// appended, and the report request keeps the tool definitions, with `tool_choice: "none"` asking for no calls.
async fn run_standard_strategy(
  config: &Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  user: &UserRecord,
  resources: ChatResources,
  log: &mut RunLog,
  progress: &ChatProgressReporter,
) -> InfuResult<String> {
  let ChatResources { endpoint, infumap_data, tools, name_map, approval_required } = resources;
  let targets: BTreeMap<_, _> = name_map.iter().map(|(name, target)| (name.clone(), target.clone())).collect();
  let mode = ChatRunMode::DeepResearch;
  let system_prompt =
    chat_system_prompt(&*db.lock().await, Some(user.started_at), infumap_data.as_ref(), !name_map.is_empty(), mode);
  let mut messages =
    vec![OpenAiChatMessage::text("system", system_prompt), OpenAiChatMessage::text("user", user.model_content())];
  let tool_context = ChatToolContext { mode, model: endpoint.model.clone(), call_counts: Mutex::new(HashMap::new()) };
  let (mut round, mut tool_rounds) = (1usize, 0usize);

  let stages =
    [("research", "Researching sources", None), ("review", "Reviewing evidence", Some(RESEARCH_REVIEW_PROMPT))];
  for (stage, status, instruction) in stages {
    log.stage(stage).await?;
    progress.status(status).await;
    if let Some(instruction) = instruction {
      messages.push(OpenAiChatMessage::text("system", instruction.to_owned()));
    }
    loop {
      let completed =
        research_round(&endpoint, &messages, &tools, None, round, tool_rounds, stage, &targets, log, progress).await?;
      round += 1;
      if completed.tool_calls.is_empty() {
        messages.push(completed.assistant_message);
        break;
      }
      if tool_rounds >= RESEARCH_MAX_TOOL_ROUNDS {
        return Err(format!("Chat tool loop exceeded maximum tool rounds ({RESEARCH_MAX_TOOL_ROUNDS}).").into());
      }
      tool_rounds += 1;
      messages.push(completed.assistant_message);
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
      messages.extend(tool_messages);
    }
  }

  log.stage("report").await?;
  progress.status("Writing research report").await;
  messages.push(OpenAiChatMessage::text("system", RESEARCH_REPORT_PROMPT.to_owned()));
  let tool_choice = (!tools.is_empty()).then_some("none");
  let completed =
    research_round(&endpoint, &messages, &tools, tool_choice, round, tool_rounds, "report", &targets, log, progress)
      .await?;
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
  let end = run.end.as_ref();
  let status = match end.map(|end| end.outcome) {
    Some(TurnOutcome::Completed) => TurnStatus::Completed,
    Some(TurnOutcome::Cancelled) => TurnStatus::Cancelled,
    Some(TurnOutcome::Error) => TurnStatus::Error,
    None if running => TurnStatus::Running,
    None => TurnStatus::Interrupted,
  };
  let report = end.and_then(|end| end.report.clone());
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
    rounds: end.map(|end| end.rounds.clone()).unwrap_or_default(),
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
    research: Some(LoadResearch { strategy: run.header.strategy, stages: run.stages }),
  }
}

/// The MIME type of a kept run's log, attached to its report. Set explicitly, so the JSONL is never indexed as text.
pub(super) const RESEARCH_RUN_MIME_TYPE: &str = "application/x-infumap-research-run";

/// Keeps a finished run in the item tree where it was dropped: its report as a Markdown text item, with the run log
/// attached, so what the model was given stays with what it wrote. The query item and the log in the data directory
/// are then removed, as when a chat is kept. A run without a report has nothing to keep.
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
  let lock = transcript::try_lock_chat(user_id, query_item_id)
    .ok_or("This research run is still running. Keep it when it has finished.")?;
  let path = run_log_path(data_dir, user_id, query_item_id)?;
  let run = parse_run(&tokio::fs::read(&path).await?)?.ok_or("The research run was not found.")?;
  let report = run
    .end
    .as_ref()
    .and_then(|end| end.report.clone())
    .ok_or("This research run has no report to keep. Delete it instead.")?;
  drop(lock);
  // The title is generated when the run starts; this only fills in one that never arrived.
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

  let text_item = |id: &Uid, title: String, size: usize| {
    let mut map = request.item.clone();
    map.insert("id".to_owned(), Value::String(id.clone()));
    map.insert("itemType".to_owned(), Value::String(ItemType::Text.as_str().to_owned()));
    map.insert("ownerId".to_owned(), Value::String(user_id.clone()));
    map.insert("title".to_owned(), Value::String(title));
    map.insert("fileSizeBytes".to_owned(), Value::Number(size.into()));
    map.remove("mimeType");
    map
  };
  let report_id = new_uid();
  let report_json = serde_json::to_string(&Value::Object(text_item(&report_id, format!("{title}.md"), report.len())))?;
  let added = super::super::item_ops::add_item_for_user_with_mime_type(
    db,
    object_store.clone(),
    &report_json,
    &Some(general_purpose::STANDARD.encode(report.as_bytes())),
    user_id,
    Some("text/markdown"),
  )
  .await?
  .ok_or("Adding the report item returned nothing.")?;

  let mut log_map = text_item(&new_uid(), format!("{title}.run"), log.len());
  log_map.insert("parentId".to_owned(), Value::String(report_id.clone()));
  log_map.insert("relationshipToParent".to_owned(), Value::String("attachment".to_owned()));
  log_map.insert(
    "ordering".to_owned(),
    Value::Array(crate::util::ordering::new_ordering().into_iter().map(|byte| byte.into()).collect()),
  );
  log_map.remove("groupId");
  log_map.remove("pinnedTo");
  let attached = super::super::item_ops::add_item_for_user_with_mime_type(
    db,
    object_store.clone(),
    &serde_json::to_string(&Value::Object(log_map))?,
    &Some(general_purpose::STANDARD.encode(&log)),
    user_id,
    Some(RESEARCH_RUN_MIME_TYPE),
  )
  .await;
  let attached = match attached {
    Ok(Some(attached)) => attached,
    result => {
      // Without its log the report is not what was asked to be kept: remove it and leave the run as it was.
      let delete_json = serde_json::json!({ "id": report_id }).to_string();
      if let Err(e) = super::super::item_ops::handle_delete_item(
        db,
        object_store.clone(),
        image_cache.clone(),
        &delete_json,
        &Some(session.clone()),
      )
      .await
      {
        warn!("Could not remove the report of research run '{}' after attaching its log failed: {}", query_item_id, e);
      }
      return Err(match result {
        Err(e) => e,
        _ => "Adding the run log returned nothing.".into(),
      });
    }
  };

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
  let mut result: Value = serde_json::from_str(&added)?;
  let attachment: Value = serde_json::from_str(&attached)?;
  result["attachments"] = Value::Array(attachment.get("item").cloned().into_iter().collect());
  Ok(serde_json::to_string(&result)?)
}

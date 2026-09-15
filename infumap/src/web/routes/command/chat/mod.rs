// Copyright (C) The Infumap Authors
// This file is part of Infumap.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use super::*;
use http_body_util::{BodyExt as _, StreamBody};
use hyper::body::Frame;
use std::collections::HashMap;
use std::io::Write as _;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::web::serve::{empty_body, forbidden_response, not_found_response};

mod markdown;
mod web_search;
use markdown::chat_response_items_json;

const CHAT_LLAMA_CONNECT_TIMEOUT_SECS: u64 = 30;
const CHAT_LLAMA_READ_TIMEOUT_SECS: u64 = 120;
const CHAT_MAX_TOOL_ROUNDS: usize = 10_000;
const CHAT_TOOL_APPROVAL_TIMEOUT_SECS: u64 = 300;
const CHAT_TOOL_APPROVAL_REQUEST_MAX_BYTES: usize = 16 * 1024;
const CHAT_LEXICAL_SEARCH_TOOL_DEFAULT_NUM_RESULTS: i64 = 8;
const CHAT_LEXICAL_SEARCH_TOOL_MAX_NUM_RESULTS: i64 = 20;
const CHAT_FRAGMENT_TOOL_DEFAULT_MAX_CHARS: usize = 2_500;
const CHAT_TOOL_PREVIEW_TEXT_MAX_CHARS: usize = 280;
const CHAT_TOOL_SUMMARY_QUERY_MAX_CHARS: usize = 80;
const CHAT_TOOL_SUMMARY_TITLE_COUNT: usize = 3;
const LLM_LOG_PATH: &str = "/tmp/llm.txt";
const CHAT_INFUMAP_SYSTEM_PROMPT: &str = "\
You are a chat assistant for an information workspace.

Use lexical_search by default to locate items, discover likely relevant items, or search document text.
lexical_search searches titles and document text using lexical matching.
lexical_search results include linkUrl values. When you mention a specific search result item by title, link the title using Markdown with that exact linkUrl, for example [title](infumap://0123456789abcdef0123456789abcdef).
Only use linkUrl values returned by tools; do not invent item links or expose raw item ids in visible text.
Use get_fragment when a lexical_search snippet is truncated, ambiguous, or too small to answer from confidently.
If lexical_search results are insufficient, say what is missing rather than inventing details.
Return a concise Markdown answer.";
const CHAT_GENERAL_SYSTEM_PROMPT: &str = "\
You are a helpful chat assistant.
Return a concise Markdown answer.";
const CHAT_CAPABILITY_INFUMAP_DATA: &str = "infumap_data";
const CHAT_CAPABILITY_WEB_SEARCH: &str = "web_search";
const CHAT_SYSTEM_PROMPT_CLOSING: &str = "Return a concise Markdown answer.";
const CHAT_SYSTEM_PROMPT_WEB_SEARCH: &str = "\
Use web_search to search the public web. The user must approve the exact query before the search runs.
Use fetch_page to read an HTTP or HTTPS URL. The user must approve the exact URL before the request is sent.
Cite web sources with URLs returned by those tools; do not invent links.";

#[derive(Deserialize)]
struct ChatRequest {
  #[serde(rename = "requestId", default)]
  request_id: Option<String>,
  #[serde(default)]
  messages: Option<Vec<ChatHistoryMessage>>,
  #[serde(rename = "contextItems", default)]
  context_items: Vec<Value>,
  #[serde(rename = "userText", default)]
  user_text: String,
  #[serde(default)]
  capabilities: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct ChatHistoryMessage {
  role: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  content: Option<String>,
  #[serde(rename = "reasoningContent", default, skip_serializing_if = "Option::is_none")]
  reasoning_content: Option<String>,
  #[serde(rename = "toolCallId", default, skip_serializing_if = "Option::is_none")]
  tool_call_id: Option<String>,
  #[serde(rename = "toolCalls", default, skip_serializing_if = "Option::is_none")]
  tool_calls: Option<Vec<LlamaToolCall>>,
}

impl ChatHistoryMessage {
  fn from_llama(message: &LlamaChatMessage) -> Self {
    Self {
      role: message.role.clone(),
      content: message.content.clone(),
      reasoning_content: message.reasoning_content.clone().filter(|text| !text.is_empty()),
      tool_call_id: message.tool_call_id.clone().filter(|text| !text.is_empty()),
      tool_calls: message.tool_calls.clone().filter(|tool_calls| !tool_calls.is_empty()),
    }
  }

  fn into_llama(&self, role: &str) -> LlamaChatMessage {
    LlamaChatMessage {
      role: role.to_owned(),
      content: self.content.clone(),
      reasoning_content: if role == "assistant" {
        self.reasoning_content.clone().filter(|text| !text.is_empty())
      } else {
        None
      },
      tool_call_id: if role == "tool" { self.tool_call_id.clone().filter(|text| !text.is_empty()) } else { None },
      tool_calls: if role == "assistant" {
        self.tool_calls.clone().filter(|tool_calls| !tool_calls.is_empty())
      } else {
        None
      },
    }
  }
}

struct ChatRunResult {
  assistant_text: String,
  messages: Vec<ChatHistoryMessage>,
}

impl ChatRequest {
  fn stream_request_id(&self) -> String {
    self
      .request_id
      .as_ref()
      .filter(|request_id| !request_id.trim().is_empty())
      .cloned()
      .unwrap_or_else(new_chat_request_id)
  }

  fn uses_infumap_data(&self) -> bool {
    self.capabilities.iter().any(|capability| capability == CHAT_CAPABILITY_INFUMAP_DATA)
  }

  fn uses_web_search(&self) -> bool {
    self.capabilities.iter().any(|capability| capability == CHAT_CAPABILITY_WEB_SEARCH)
  }
}

#[derive(Serialize)]
struct ChatStreamEvent {
  #[serde(rename = "requestId")]
  request_id: String,
  #[serde(flatten)]
  kind: ChatStreamEventKind,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ChatStreamEventKind {
  Status {
    text: String,
  },
  ModelRoundStarted {
    round: usize,
  },
  ReasoningDelta {
    round: usize,
    text: String,
  },
  AnswerDelta {
    round: usize,
    text: String,
  },
  ToolApprovalRequired {
    round: usize,
    #[serde(rename = "callId")]
    call_id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
  },
  ToolCallStarted {
    round: usize,
    #[serde(rename = "callId")]
    call_id: String,
    name: String,
    arguments: Value,
  },
  ToolCallFinished {
    round: usize,
    #[serde(rename = "callId")]
    call_id: String,
    name: String,
    summary: String,
    #[serde(rename = "durationMs")]
    duration_ms: u64,
    #[serde(rename = "resultPreview")]
    result_preview: Value,
  },
  Materializing,
  ContextTokens {
    tokens: i64,
    exact: bool,
  },
  FinalItems {
    text: String,
    items: Value,
    messages: Vec<ChatHistoryMessage>,
  },
  #[allow(dead_code)] // Reserved for explicit server-originated cancellation.
  Cancelled,
  Error {
    message: String,
  },
}

impl ChatStreamEventKind {
  fn status(text: &str) -> Self {
    Self::Status { text: text.to_owned() }
  }

  fn tool_approval_required(
    round: usize,
    call_id: &str,
    name: &str,
    query: Option<String>,
    url: Option<String>,
  ) -> Self {
    Self::ToolApprovalRequired { round, call_id: call_id.to_owned(), name: name.to_owned(), query, url }
  }

  fn tool_call_started(round: usize, call_id: &str, name: &str, arguments: Value) -> Self {
    Self::ToolCallStarted { round, call_id: call_id.to_owned(), name: name.to_owned(), arguments }
  }

  fn tool_call_finished(
    round: usize,
    call_id: &str,
    name: &str,
    summary: &str,
    duration_ms: u64,
    result_preview: Value,
  ) -> Self {
    Self::ToolCallFinished {
      round,
      call_id: call_id.to_owned(),
      name: name.to_owned(),
      summary: summary.to_owned(),
      duration_ms,
      result_preview,
    }
  }

  fn context_tokens(tokens: i64, exact: bool) -> Self {
    Self::ContextTokens { tokens, exact }
  }

  fn final_items(items: Value, assistant_text: &str, messages: Vec<ChatHistoryMessage>) -> Self {
    Self::FinalItems { text: assistant_text.to_owned(), items, messages }
  }

  fn error(message: &str) -> Self {
    Self::Error { message: message.to_owned() }
  }
}

fn new_chat_request_id() -> String {
  Uuid::new_v4().simple().to_string()
}

#[derive(Clone)]
struct ChatProgressReporter {
  request_id: String,
  tx: mpsc::Sender<Result<Frame<Bytes>, hyper::Error>>,
}

impl ChatProgressReporter {
  async fn send(&self, kind: ChatStreamEventKind) {
    let event = ChatStreamEvent { request_id: self.request_id.clone(), kind };
    let line = match serde_json::to_string(&event) {
      Ok(line) => format!("{line}\n"),
      Err(_) => format!(
        "{{\"requestId\":{},\"type\":\"error\",\"message\":\"Could not serialize chat stream event.\"}}\n",
        serde_json::to_string(&self.request_id).unwrap_or_else(|_| "\"\"".to_owned()),
      ),
    };
    let _ = self.tx.send(Ok(Frame::data(Bytes::from(line)))).await;
  }

  async fn status(&self, text: &str) {
    self.send(ChatStreamEventKind::status(text)).await;
  }

  async fn model_round_started(&self, round: usize) {
    self.send(ChatStreamEventKind::ModelRoundStarted { round }).await;
  }

  async fn context_tokens(&self, tokens: i64, exact: bool) {
    self.send(ChatStreamEventKind::context_tokens(tokens, exact)).await;
  }

  async fn reasoning_delta(&self, round: usize, text: String) {
    self.send(ChatStreamEventKind::ReasoningDelta { round, text }).await;
  }

  async fn answer_delta(&self, round: usize, text: String) {
    self.send(ChatStreamEventKind::AnswerDelta { round, text }).await;
  }

  async fn tool_approval_required(
    &self,
    round: usize,
    call_id: &str,
    name: &str,
    query: Option<String>,
    url: Option<String>,
  ) {
    self.send(ChatStreamEventKind::tool_approval_required(round, call_id, name, query, url)).await;
  }

  async fn tool_call_started(&self, round: usize, call_id: &str, name: &str, arguments: Value) {
    self.send(ChatStreamEventKind::tool_call_started(round, call_id, name, arguments)).await;
  }

  async fn tool_call_finished(
    &self,
    round: usize,
    call_id: &str,
    name: &str,
    summary: &str,
    duration_ms: u64,
    result_preview: Value,
  ) {
    self
      .send(ChatStreamEventKind::tool_call_finished(round, call_id, name, summary, duration_ms, result_preview))
      .await;
  }
}

#[derive(Clone, Deserialize, Serialize)]
struct LlamaChatMessage {
  #[serde(default)]
  role: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  content: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  reasoning_content: Option<String>,
  #[serde(rename = "tool_call_id", skip_serializing_if = "Option::is_none")]
  tool_call_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  tool_calls: Option<Vec<LlamaToolCall>>,
}

impl LlamaChatMessage {
  fn text(role: &str, content: String) -> Self {
    Self {
      role: role.to_owned(),
      content: Some(content),
      reasoning_content: None,
      tool_call_id: None,
      tool_calls: None,
    }
  }

  fn tool(tool_call_id: String, content: String) -> Self {
    Self {
      role: "tool".to_owned(),
      content: Some(content),
      reasoning_content: None,
      tool_call_id: Some(tool_call_id),
      tool_calls: None,
    }
  }
}

#[derive(Clone, Deserialize, Serialize)]
struct LlamaToolCall {
  #[serde(default, skip_serializing_if = "String::is_empty")]
  id: String,
  #[serde(rename = "type", default, skip_serializing_if = "String::is_empty")]
  tool_type: String,
  function: LlamaToolCallFunction,
}

fn default_llama_tool_call_type() -> String {
  "function".to_owned()
}

#[derive(Clone, Deserialize, Serialize)]
struct LlamaToolCallFunction {
  name: String,
  #[serde(default)]
  arguments: Value,
}

#[derive(Clone, Serialize)]
struct LlamaToolSpec {
  #[serde(rename = "type")]
  tool_type: String,
  function: LlamaToolFunctionSpec,
}

#[derive(Clone, Serialize)]
struct LlamaToolFunctionSpec {
  name: String,
  description: String,
  parameters: Value,
}

#[derive(Serialize)]
struct LlamaStreamOptions {
  include_usage: bool,
}

#[derive(Serialize)]
struct LlamaChatCompletionRequest {
  model: String,
  messages: Vec<LlamaChatMessage>,
  stream: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  stream_options: Option<LlamaStreamOptions>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  tools: Vec<LlamaToolSpec>,
}

#[derive(Deserialize)]
struct LlamaChatCompletionChunk {
  #[serde(default)]
  id: Option<String>,
  #[serde(default)]
  choices: Vec<LlamaChatCompletionChoice>,
  #[serde(default)]
  usage: Option<LlamaChatCompletionUsage>,
  #[serde(default)]
  error: Option<Value>,
}

#[derive(Deserialize)]
struct LlamaChatCompletionChoice {
  #[serde(default)]
  index: usize,
  delta: LlamaChatCompletionDelta,
  #[serde(default)]
  finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct LlamaChatCompletionDelta {
  #[serde(default)]
  role: Option<String>,
  #[serde(default)]
  content: Option<String>,
  #[serde(default)]
  reasoning_content: Option<String>,
  #[serde(default)]
  tool_calls: Vec<LlamaToolCallDelta>,
  #[serde(default)]
  finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct LlamaToolCallDelta {
  index: usize,
  #[serde(default)]
  id: Option<String>,
  #[serde(rename = "type", default)]
  tool_type: Option<String>,
  #[serde(default)]
  function: Option<LlamaToolCallFunctionDelta>,
}

#[derive(Deserialize)]
struct LlamaToolCallFunctionDelta {
  #[serde(default)]
  name: Option<String>,
  #[serde(default)]
  arguments: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct LlamaChatCompletionUsage {
  #[serde(rename = "prompt_tokens")]
  prompt_tokens: Option<i64>,
  #[serde(rename = "completion_tokens")]
  completion_tokens: Option<i64>,
  #[serde(rename = "total_tokens")]
  total_tokens: Option<i64>,
}

#[derive(Deserialize)]
struct ChatLexicalSearchToolArguments {
  text: Option<String>,
  query: Option<String>,
  #[serde(rename = "pageId")]
  page_id: Option<Uid>,
  #[serde(rename = "numResults")]
  num_results: Option<i64>,
  #[serde(rename = "pageNum")]
  page_num: Option<i64>,
}

#[derive(Deserialize)]
struct ChatFragmentToolArguments {
  #[serde(rename = "itemId")]
  item_id: Option<Uid>,
  #[serde(rename = "fragmentOrdinal")]
  fragment_ordinal: Option<i64>,
  ordinal: Option<i64>,
}

#[derive(Deserialize)]
struct ChatWebSearchToolArguments {
  query: Option<String>,
  text: Option<String>,
  #[serde(rename = "numResults")]
  num_results: Option<i64>,
}

#[derive(Deserialize)]
struct ChatFetchPageToolArguments {
  url: Option<String>,
  #[serde(rename = "maxChars")]
  max_chars: Option<i64>,
}

pub async fn serve_chat_stream_route(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  request: Request<hyper::body::Incoming>,
) -> Response<BoxBody<Bytes, hyper::Error>> {
  if request.method() == "OPTIONS" {
    debug!("Serving OPTIONS request for chat stream, assuming CORS query.");
    return cors_response();
  }

  let request_id = request
    .headers()
    .get("x-infumap-chat-request-id")
    .and_then(|value| value.to_str().ok())
    .filter(|value| !value.trim().is_empty())
    .map(str::to_owned)
    .unwrap_or_else(new_chat_request_id);
  let session_maybe = get_and_validate_session(&request, db).await;
  let session = match session_maybe {
    Some(session) => session,
    None => {
      return single_chat_stream_event_response(
        request_id,
        ChatStreamEventKind::error("Session is required to run a chat query."),
      );
    }
  };

  let request: ChatRequest = match incoming_json_with_limit(request, COMMAND_REQUEST_MAX_BYTES).await {
    Ok(request) => request,
    Err(e) => {
      error!("An error occurred parsing chat stream payload for user '{}': {}", session.user_id, e);
      return single_chat_stream_event_response(
        request_id,
        ChatStreamEventKind::error("Could not parse chat request."),
      );
    }
  };

  let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, hyper::Error>>(16);
  let progress = ChatProgressReporter { request_id: request.stream_request_id(), tx: tx.clone() };
  let disconnect = tx.clone();
  let user_id = session.user_id.clone();
  let db = db.clone();

  tokio::spawn(async move {
    progress.status("Preparing request").await;
    let result = tokio::select! {
      _ = disconnect.closed() => {
        debug!("Cancelling streaming chat request '{}' for user '{}' after the client disconnected.", progress.request_id, user_id);
        cancel_pending_tool_approvals(&progress.request_id);
        return;
      }
      result = run_chat_with_tools(config, &db, &session, &request, &progress) => result,
    };
    cancel_pending_tool_approvals(&progress.request_id);
    match result {
      Ok(result) => {
        progress.send(ChatStreamEventKind::Materializing).await;
        let response = chat_response_items_json(&user_id, &result.assistant_text);
        let items = response.get("items").cloned().unwrap_or_else(|| Value::Array(Vec::new()));
        progress.send(ChatStreamEventKind::final_items(items, &result.assistant_text, result.messages)).await;
      }
      Err(e) => {
        warn!("An error occurred servicing a streaming chat request for user '{}': {}.", user_id, e);
        progress.send(ChatStreamEventKind::error(&chat_failure_message(e.message()))).await;
      }
    }
  });

  chat_stream_response(rx)
}

#[derive(Deserialize)]
struct ChatToolApprovalRequest {
  #[serde(rename = "requestId")]
  request_id: String,
  #[serde(rename = "callId")]
  call_id: String,
  approved: bool,
}

#[derive(Serialize)]
struct ChatToolApprovalResponse {
  ok: bool,
}

enum ToolApprovalDecision {
  Approved,
  Denied,
  TimedOut,
}

struct PendingToolApproval {
  user_id: Uid,
  tx: oneshot::Sender<bool>,
}

fn pending_tool_approvals() -> &'static Mutex<HashMap<(String, String), PendingToolApproval>> {
  static PENDING: OnceLock<Mutex<HashMap<(String, String), PendingToolApproval>>> = OnceLock::new();
  PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_pending_tool_approvals() -> std::sync::MutexGuard<'static, HashMap<(String, String), PendingToolApproval>> {
  pending_tool_approvals().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cancel_pending_tool_approvals(request_id: &str) {
  let mut pending = lock_pending_tool_approvals();
  let keys: Vec<(String, String)> =
    pending.keys().filter(|(pending_request_id, _)| pending_request_id == request_id).cloned().collect();
  for key in keys {
    if let Some(approval) = pending.remove(&key) {
      let _ = approval.tx.send(false);
    }
  }
}

async fn wait_for_tool_approval(request_id: &str, call_id: &str, user_id: &Uid) -> ToolApprovalDecision {
  let (tx, rx) = oneshot::channel();
  {
    let mut pending = lock_pending_tool_approvals();
    if let Some(previous) =
      pending.insert((request_id.to_owned(), call_id.to_owned()), PendingToolApproval { user_id: user_id.clone(), tx })
    {
      let _ = previous.tx.send(false);
    }
  }
  let decision = match tokio::time::timeout(Duration::from_secs(CHAT_TOOL_APPROVAL_TIMEOUT_SECS), rx).await {
    Ok(Ok(true)) => ToolApprovalDecision::Approved,
    Ok(Ok(false)) | Ok(Err(_)) => ToolApprovalDecision::Denied,
    Err(_) => ToolApprovalDecision::TimedOut,
  };
  lock_pending_tool_approvals().remove(&(request_id.to_owned(), call_id.to_owned()));
  decision
}

enum ToolApprovalResolveError {
  NotFound,
  Forbidden,
}

fn resolve_pending_tool_approval(
  request_id: &str,
  call_id: &str,
  user_id: &Uid,
  approved: bool,
) -> Result<(), ToolApprovalResolveError> {
  let mut pending = lock_pending_tool_approvals();
  match pending.remove(&(request_id.to_owned(), call_id.to_owned())) {
    None => Err(ToolApprovalResolveError::NotFound),
    Some(approval) if approval.user_id != *user_id => {
      pending.insert((request_id.to_owned(), call_id.to_owned()), approval);
      Err(ToolApprovalResolveError::Forbidden)
    }
    Some(approval) => {
      let _ = approval.tx.send(approved);
      Ok(())
    }
  }
}

pub async fn serve_chat_tool_approval_route(
  db: &Arc<tokio::sync::Mutex<Db>>,
  request: Request<hyper::body::Incoming>,
) -> Response<BoxBody<Bytes, hyper::Error>> {
  if request.method() == "OPTIONS" {
    debug!("Serving OPTIONS request for chat tool approval, assuming CORS query.");
    return cors_response();
  }
  if request.method() != "POST" {
    return not_found_response();
  }

  let session_maybe = get_and_validate_session(&request, db).await;
  let session = match session_maybe {
    Some(session) => session,
    None => return forbidden_response(),
  };

  let request: ChatToolApprovalRequest =
    match incoming_json_with_limit(request, CHAT_TOOL_APPROVAL_REQUEST_MAX_BYTES).await {
      Ok(request) => request,
      Err(e) => {
        error!("An error occurred parsing chat tool approval payload for user '{}': {}", session.user_id, e);
        return Response::builder().status(400).body(empty_body()).unwrap();
      }
    };
  if request.request_id.trim().is_empty() || request.call_id.trim().is_empty() {
    return not_found_response();
  }

  match resolve_pending_tool_approval(&request.request_id, &request.call_id, &session.user_id, request.approved) {
    Ok(()) => json_response(&ChatToolApprovalResponse { ok: true }),
    Err(ToolApprovalResolveError::Forbidden) => forbidden_response(),
    Err(ToolApprovalResolveError::NotFound) => not_found_response(),
  }
}

fn single_chat_stream_event_response(
  request_id: String,
  event: ChatStreamEventKind,
) -> Response<BoxBody<Bytes, hyper::Error>> {
  let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, hyper::Error>>(1);
  tokio::spawn(async move {
    let reporter = ChatProgressReporter { request_id, tx };
    reporter.send(event).await;
  });
  chat_stream_response(rx)
}

fn chat_stream_response(
  rx: mpsc::Receiver<Result<Frame<Bytes>, hyper::Error>>,
) -> Response<BoxBody<Bytes, hyper::Error>> {
  let body = StreamBody::new(ReceiverStream::new(rx)).boxed();
  Response::builder()
    .header(hyper::header::CONTENT_TYPE, "application/x-ndjson")
    .header(hyper::header::CACHE_CONTROL, "no-cache")
    .header(hyper::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
    .body(body)
    .unwrap_or_else(|_| Response::builder().status(500).body(empty_body()).unwrap())
}

fn configured_llama_chat_url(config: &Config) -> InfuResult<reqwest::Url> {
  let raw_url = config.get_string(CONFIG_LLAMA_SERVER_URL).map_err(|e| e.to_string())?;
  let trimmed_url = raw_url.trim();
  if trimmed_url.is_empty() {
    return Err(format!("{} must be configured to use Chat.", CONFIG_LLAMA_SERVER_URL).into());
  }

  let endpoint_path = "/v1/chat/completions";
  let parsed = reqwest::Url::parse(trimmed_url)
    .map_err(|e| format!("Could not parse {} '{}': {}", CONFIG_LLAMA_SERVER_URL, trimmed_url, e))?;
  if parsed.path().trim_end_matches('/').ends_with(endpoint_path) {
    return Ok(parsed);
  }

  let base_url = reqwest::Url::parse(&format!("{}/", trimmed_url.trim_end_matches('/')))
    .map_err(|e| format!("Could not parse {} '{}': {}", CONFIG_LLAMA_SERVER_URL, trimmed_url, e))?;
  base_url
    .join("v1/chat/completions")
    .map_err(|e| format!("Could not build llama-server chat endpoint from '{}': {}", trimmed_url, e).into())
}

fn chat_item_id(item: &Value) -> Option<&str> {
  item.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())
}

fn chat_item_parent_id(item: &Value) -> Option<&str> {
  item.get("parentId").and_then(Value::as_str).filter(|parent_id| !parent_id.is_empty())
}

fn chat_item_title(item: &Value) -> &str {
  item.get("title").and_then(Value::as_str).unwrap_or("")
}

fn chat_root_role(item: &Value) -> Option<&'static str> {
  let title = chat_item_title(item).trim().to_lowercase();
  if title == "you" || title == "user" {
    return Some("user");
  }
  if title == "assistant" {
    return Some("assistant");
  }
  None
}

fn collect_chat_text(
  item_id: &str,
  items_by_id: &HashMap<String, &Value>,
  children_by_parent_id: &HashMap<String, Vec<String>>,
  visited: &mut HashSet<String>,
  output: &mut Vec<String>,
) {
  if !visited.insert(item_id.to_owned()) {
    return;
  }

  let Some(item) = items_by_id.get(item_id) else {
    return;
  };

  let item_type = item.get("itemType").and_then(Value::as_str).unwrap_or("");
  if matches!(item_type, "note" | "text" | "file") {
    let title = chat_item_title(item).trim();
    if !title.is_empty() {
      output.push(title.to_owned());
    }
  }

  if let Some(children) = children_by_parent_id.get(item_id) {
    for child_id in children {
      collect_chat_text(child_id, items_by_id, children_by_parent_id, visited, output);
    }
  }
}

fn text_char_count(text: &str) -> usize {
  text.chars().count()
}

fn clamp_text_chars(text: &str, max_chars: usize) -> (String, bool) {
  if max_chars == 0 {
    return (String::new(), !text.is_empty());
  }

  let mut chars = text.chars();
  let truncated: String = chars.by_ref().take(max_chars).collect();
  (truncated, chars.next().is_some())
}

fn message_content_chars(message: &LlamaChatMessage) -> usize {
  message.content.as_deref().map(text_char_count).unwrap_or(0)
}

fn message_reasoning_chars(message: &LlamaChatMessage) -> usize {
  message.reasoning_content.as_deref().map(text_char_count).unwrap_or(0)
}

fn explicit_llama_messages(messages: &[ChatHistoryMessage]) -> InfuResult<Vec<LlamaChatMessage>> {
  let mut llama_messages = Vec::with_capacity(messages.len());
  for (index, message) in messages.iter().enumerate() {
    let role = message.role.trim().to_lowercase();
    if role == "system" {
      continue;
    }
    if role != "user" && role != "assistant" && role != "tool" {
      return Err(format!("Chat history message {} has unsupported role '{}'.", index, message.role).into());
    }
    if role == "tool" && message.tool_call_id.as_deref().unwrap_or("").trim().is_empty() {
      return Err(format!("Chat history message {} is missing toolCallId.", index).into());
    }
    llama_messages.push(message.into_llama(&role));
  }
  Ok(llama_messages)
}

fn chat_history_from_llama_messages(messages: &[LlamaChatMessage]) -> Vec<ChatHistoryMessage> {
  messages
    .iter()
    .filter(|message| !message.role.eq_ignore_ascii_case("system"))
    .map(ChatHistoryMessage::from_llama)
    .collect()
}

fn legacy_llama_messages_from_chat_request(request: &ChatRequest) -> Vec<LlamaChatMessage> {
  let mut ids = HashSet::new();
  let mut items_by_id: HashMap<String, &Value> = HashMap::new();
  for item in &request.context_items {
    if let Some(id) = chat_item_id(item) {
      ids.insert(id.to_owned());
      items_by_id.insert(id.to_owned(), item);
    }
  }

  let mut children_by_parent_id: HashMap<String, Vec<String>> = HashMap::new();
  for item in &request.context_items {
    let Some(item_id) = chat_item_id(item) else {
      continue;
    };
    if let Some(parent_id) = chat_item_parent_id(item) {
      children_by_parent_id.entry(parent_id.to_owned()).or_default().push(item_id.to_owned());
    }
  }

  let mut messages = Vec::new();
  for item in &request.context_items {
    let Some(item_id) = chat_item_id(item) else {
      continue;
    };
    if chat_item_parent_id(item).is_some_and(|parent_id| ids.contains(parent_id)) {
      continue;
    }
    let Some(role) = chat_root_role(item) else {
      continue;
    };

    let mut text_parts = Vec::new();
    let mut visited = HashSet::new();
    collect_chat_text(item_id, &items_by_id, &children_by_parent_id, &mut visited, &mut text_parts);
    let content = text_parts.join("\n\n").trim().to_owned();
    if !content.is_empty() {
      messages.push(LlamaChatMessage::text(role, content));
    }
  }

  let current_user_text = request.user_text.trim();
  if !current_user_text.is_empty() {
    messages.push(LlamaChatMessage::text("user", current_user_text.to_owned()));
  }
  messages
}

fn chat_system_prompt(uses_infumap_data: bool, uses_web_search: bool) -> String {
  let base = if uses_infumap_data { CHAT_INFUMAP_SYSTEM_PROMPT } else { CHAT_GENERAL_SYSTEM_PROMPT };
  if !uses_web_search {
    return base.to_owned();
  }
  let mut prompt = base.strip_suffix(CHAT_SYSTEM_PROMPT_CLOSING).unwrap_or(base).trim_end().to_owned();
  prompt.push_str("\n\n");
  prompt.push_str(CHAT_SYSTEM_PROMPT_WEB_SEARCH);
  prompt.push('\n');
  prompt.push_str(CHAT_SYSTEM_PROMPT_CLOSING);
  prompt
}

fn llama_messages_from_chat_request(request: &ChatRequest) -> InfuResult<Vec<LlamaChatMessage>> {
  match request.messages.as_deref() {
    Some(messages) => explicit_llama_messages(messages),
    None => Ok(legacy_llama_messages_from_chat_request(request)),
  }
}

fn chat_failure_message(message: &str) -> String {
  if message.contains("exceeded maximum tool rounds") {
    return format!("Exceeded maximum tool rounds ({CHAT_MAX_TOOL_ROUNDS}).");
  }
  if message.contains("empty chat response") {
    return "The model returned an empty response.".to_owned();
  }
  if message.contains("must be configured to use Chat") {
    return "The language model server is not configured.".to_owned();
  }
  if message.contains("Could not send chat request") || message.contains("[kind=connect]") {
    return "Could not reach the language model server.".to_owned();
  }
  if message.contains("timeout") || message.contains("timed out") {
    return "The language model request timed out.".to_owned();
  }
  if message.contains("returned no chat response choices") {
    return "The model returned no response.".to_owned();
  }
  if message.contains("SSE response ended") {
    return "The model stream ended unexpectedly.".to_owned();
  }
  if message.contains("unexpected chat response role") {
    return "The model returned an unexpected response.".to_owned();
  }
  if message.contains("streaming error") {
    return "The language model reported an error.".to_owned();
  }
  if message.contains("llama-server chat endpoint") && message.contains("returned") {
    return "The language model server rejected the request.".to_owned();
  }
  if message.contains("Chat request did not contain any message text") {
    return "The chat request did not contain any message text.".to_owned();
  }
  "Chat failed.".to_owned()
}

fn truncate_for_error(text: &str, max_chars: usize) -> String {
  let mut chars = text.chars();
  let truncated: String = chars.by_ref().take(max_chars).collect();
  if chars.next().is_some() { format!("{}...", truncated) } else { truncated }
}

fn error_chain_for_log(error: &dyn std::error::Error) -> String {
  let mut result = error.to_string();
  let mut source_maybe = error.source();
  while let Some(source) = source_maybe {
    result.push_str(": ");
    result.push_str(&source.to_string());
    source_maybe = source.source();
  }
  result
}

fn reqwest_error_for_log(error: &reqwest::Error) -> String {
  let mut kinds = Vec::new();
  if error.is_timeout() {
    kinds.push("timeout");
  }
  if error.is_connect() {
    kinds.push("connect");
  }
  if error.is_builder() {
    kinds.push("builder");
  }
  if error.is_redirect() {
    kinds.push("redirect");
  }
  if error.is_status() {
    kinds.push("status");
  }
  if error.is_body() {
    kinds.push("body");
  }
  if error.is_decode() {
    kinds.push("decode");
  }
  let kind_suffix = if kinds.is_empty() { "".to_owned() } else { format!(" [kind={}]", kinds.join(",")) };
  format!("{}{}", error_chain_for_log(error), kind_suffix)
}

fn reset_llm_log() {
  if let Err(e) = std::fs::write(LLM_LOG_PATH, "") {
    warn!("Could not reset LLM log '{}': {}", LLM_LOG_PATH, e);
  }
}

fn append_llm_log_section(title: &str, body: &str) {
  let body = pretty_llm_log_body(body);
  match std::fs::OpenOptions::new().create(true).append(true).open(LLM_LOG_PATH) {
    Ok(mut file) => {
      if let Err(e) = writeln!(file, "\n===== {} =====\n{}", title, body) {
        warn!("Could not write LLM log '{}': {}", LLM_LOG_PATH, e);
      }
    }
    Err(e) => warn!("Could not open LLM log '{}': {}", LLM_LOG_PATH, e),
  }
}

fn pretty_llm_log_body(body: &str) -> String {
  serde_json::from_str::<Value>(body)
    .and_then(|value| serde_json::to_string_pretty(&value))
    .unwrap_or_else(|_| body.to_owned())
}

fn append_llm_json_log_section<T: Serialize>(title: &str, value: &T) {
  let body =
    serde_json::to_string_pretty(value).unwrap_or_else(|e| format!("Could not serialize LLM log value: {}", e));
  append_llm_log_section(title, &body);
}

fn approx_chars_to_tokens(chars: usize) -> i64 {
  ((chars + 3) / 4) as i64
}

fn request_char_counts(messages: &[LlamaChatMessage], tools: &[LlamaToolSpec]) -> (usize, usize, usize) {
  let content_chars = messages.iter().map(message_content_chars).sum::<usize>();
  let reasoning_chars = messages.iter().map(message_reasoning_chars).sum::<usize>();
  let tool_schema_chars = serde_json::to_string(tools).map(|text| text_char_count(&text)).unwrap_or(0);
  (content_chars, reasoning_chars, tool_schema_chars)
}

fn approx_request_tokens(messages: &[LlamaChatMessage], tools: &[LlamaToolSpec]) -> i64 {
  let (content_chars, reasoning_chars, tool_schema_chars) = request_char_counts(messages, tools);
  approx_chars_to_tokens(content_chars + reasoning_chars + tool_schema_chars)
}

fn append_llm_request_metrics_log(llm_turn: usize, messages: &[LlamaChatMessage], tools: &[LlamaToolSpec]) {
  let (content_chars, reasoning_chars, tool_schema_chars) = request_char_counts(messages, tools);
  let message_chars = content_chars + reasoning_chars;
  let total_request_chars = message_chars + tool_schema_chars;
  let tool_result_chars =
    messages.iter().filter(|message| message.role == "tool").map(message_content_chars).sum::<usize>();
  let metrics = serde_json::json!({
    "messageCount": messages.len(),
    "toolCount": tools.len(),
    "contentChars": content_chars,
    "reasoningChars": reasoning_chars,
    "messageChars": message_chars,
    "toolSchemaChars": tool_schema_chars,
    "totalRequestChars": total_request_chars,
    "approxContentTokens": approx_chars_to_tokens(content_chars),
    "approxReasoningTokens": approx_chars_to_tokens(reasoning_chars),
    "approxMessageTokens": approx_chars_to_tokens(message_chars),
    "approxRequestTokens": approx_chars_to_tokens(total_request_chars),
    "toolResultChars": tool_result_chars
  });
  append_llm_json_log_section(&format!("LLM REQUEST METRICS {}", llm_turn), &metrics);
}

fn lexical_search_tool_spec() -> LlamaToolSpec {
  LlamaToolSpec {
    tool_type: "function".to_owned(),
    function: LlamaToolFunctionSpec {
      name: "lexical_search".to_owned(),
      description: "Search workspace titles and document text using lexical matching. Use this as the default lookup and search tool.".to_owned(),
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "text": {
            "type": "string",
            "description": "Lexical text query to search for."
          },
          "pageId": {
            "type": ["string", "null"],
            "description": "Optional workspace page id to search within. Use null or omit it to search the user's home scope."
          },
          "numResults": {
            "type": "integer",
            "minimum": 1,
            "maximum": CHAT_LEXICAL_SEARCH_TOOL_MAX_NUM_RESULTS,
            "description": "Maximum number of search results to return."
          },
          "pageNum": {
            "type": "integer",
            "minimum": 1,
            "description": "Optional one-based page of search results."
          }
        },
        "required": ["text"],
        "additionalProperties": false
      }),
    },
  }
}

fn get_fragment_tool_spec() -> LlamaToolSpec {
  LlamaToolSpec {
    tool_type: "function".to_owned(),
    function: LlamaToolFunctionSpec {
      name: "get_fragment".to_owned(),
      description:
        "Fetch bounded full text for a specific lexical_search result fragment by item id and fragment ordinal."
          .to_owned(),
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "itemId": {
            "type": "string",
            "description": "Item id from a lexical_search result."
          },
          "fragmentOrdinal": {
            "type": "integer",
            "minimum": 0,
            "description": "Fragment ordinal from a lexical_search result."
          }
        },
        "required": ["itemId", "fragmentOrdinal"],
        "additionalProperties": false
      }),
    },
  }
}

fn fetch_page_tool_spec() -> LlamaToolSpec {
  LlamaToolSpec {
    tool_type: "function".to_owned(),
    function: LlamaToolFunctionSpec {
      name: "fetch_page".to_owned(),
      description: "Read an HTTP or HTTPS URL. The user must approve the exact URL before the request is sent."
        .to_owned(),
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "HTTP or HTTPS URL to fetch."
          },
          "maxChars": {
            "type": "integer",
            "minimum": 1,
            "maximum": web_search::MAX_CHARS_CAP,
            "description": "Maximum number of characters of page text to return."
          }
        },
        "required": ["url"],
        "additionalProperties": false
      }),
    },
  }
}

fn web_search_tool_spec() -> LlamaToolSpec {
  LlamaToolSpec {
    tool_type: "function".to_owned(),
    function: LlamaToolFunctionSpec {
      name: "web_search".to_owned(),
      description: "Search the public web. The user must approve the exact query before the search runs.".to_owned(),
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Web search query."
          },
          "numResults": {
            "type": "integer",
            "minimum": 1,
            "maximum": web_search::MAX_RESULTS_CAP,
            "description": "Maximum number of search results to return."
          }
        },
        "required": ["query"],
        "additionalProperties": false
      }),
    },
  }
}

fn chat_tool_specs(uses_infumap_data: bool, uses_web_search: bool) -> Vec<LlamaToolSpec> {
  let mut tools = Vec::new();
  if uses_infumap_data {
    tools.push(lexical_search_tool_spec());
    tools.push(get_fragment_tool_spec());
  }
  if uses_web_search {
    tools.push(web_search_tool_spec());
    tools.push(fetch_page_tool_spec());
  }
  tools
}

struct CompletedChatModelRound {
  number: usize,
  assistant_message: LlamaChatMessage,
  tool_calls: Vec<LlamaToolCall>,
}

async fn run_chat_model_round(
  config: &Config,
  messages: &[LlamaChatMessage],
  tools: &[LlamaToolSpec],
  round: usize,
  tool_rounds_completed: usize,
  progress: &ChatProgressReporter,
) -> InfuResult<CompletedChatModelRound> {
  progress.model_round_started(round).await;

  let mut assistant_message = llama_chat_completion(config, messages, tools, round, progress).await?;
  let response_role = assistant_message.role.trim();
  if response_role.is_empty() {
    assistant_message.role = "assistant".to_owned();
  } else if !response_role.eq_ignore_ascii_case("assistant") {
    return Err(format!("llama-server returned unexpected chat response role '{}'.", assistant_message.role).into());
  }
  let tool_calls = execution_tool_calls(&assistant_message, tool_rounds_completed);

  Ok(CompletedChatModelRound { number: round, assistant_message, tool_calls })
}

fn chat_tool_requires_approval(name: &str) -> bool {
  name == "web_search" || name == "fetch_page"
}

fn web_tool_approval_prompt(name: &str, arguments: &Value) -> (Option<String>, Option<String>) {
  match name {
    "web_search" => {
      (json_object_string_raw(arguments, "query").or_else(|| json_object_string_raw(arguments, "text")), None)
    }
    "fetch_page" => (None, json_object_string_raw(arguments, "url")),
    _ => (None, None),
  }
}

async fn execute_chat_tool_round(
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  uses_infumap_data: bool,
  uses_web_search: bool,
  round: usize,
  tool_calls: Vec<LlamaToolCall>,
  progress: &ChatProgressReporter,
) -> InfuResult<Vec<LlamaChatMessage>> {
  let mut tool_messages = Vec::with_capacity(tool_calls.len());
  for tool_call in tool_calls {
    let arguments = tool_call_arguments_value(&tool_call).unwrap_or_else(|_| serde_json::json!({}));
    if uses_web_search && chat_tool_requires_approval(&tool_call.function.name) {
      let (query, url) = web_tool_approval_prompt(&tool_call.function.name, &arguments);
      progress.tool_approval_required(round, &tool_call.id, &tool_call.function.name, query, url).await;
      match wait_for_tool_approval(&progress.request_id, &tool_call.id, &session.user_id).await {
        ToolApprovalDecision::Approved => {}
        decision => {
          let tool_result = tool_error_json(match decision {
            ToolApprovalDecision::TimedOut => "Tool approval timed out.",
            _ => "User declined.",
          });
          let (summary, result_preview) =
            chat_tool_finished_activity(&tool_call.function.name, &arguments, &tool_result);
          progress
            .tool_call_finished(round, &tool_call.id, &tool_call.function.name, &summary, 0, result_preview)
            .await;
          append_llm_log_section(&format!("TOOL RESULT {} {}", tool_call.function.name, tool_call.id), &tool_result);
          tool_messages.push(LlamaChatMessage::tool(tool_call.id, tool_result));
          continue;
        }
      }
    }
    progress.tool_call_started(round, &tool_call.id, &tool_call.function.name, arguments.clone()).await;
    let started_at = Instant::now();
    let tool_result = execute_chat_tool_call(db, session, &tool_call, uses_infumap_data, uses_web_search).await?;
    let duration_ms = started_at.elapsed().as_millis() as u64;
    let (summary, result_preview) = chat_tool_finished_activity(&tool_call.function.name, &arguments, &tool_result);
    progress
      .tool_call_finished(round, &tool_call.id, &tool_call.function.name, &summary, duration_ms, result_preview)
      .await;
    append_llm_log_section(&format!("TOOL RESULT {} {}", tool_call.function.name, tool_call.id), &tool_result);
    tool_messages.push(LlamaChatMessage::tool(tool_call.id, tool_result));
  }
  Ok(tool_messages)
}

async fn run_chat_with_tools(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  request: &ChatRequest,
  progress: &ChatProgressReporter,
) -> InfuResult<ChatRunResult> {
  reset_llm_log();

  let mut messages = llama_messages_from_chat_request(request)?;
  if messages.is_empty() {
    return Err("Chat request did not contain any message text.".into());
  }
  let uses_infumap_data = request.uses_infumap_data();
  let uses_web_search = request.uses_web_search();
  messages.insert(0, LlamaChatMessage::text("system", chat_system_prompt(uses_infumap_data, uses_web_search)));

  let tools = chat_tool_specs(uses_infumap_data, uses_web_search);
  let mut llm_turn = 1usize;
  let mut tool_rounds = 0usize;

  loop {
    let completed_round =
      run_chat_model_round(config.as_ref(), &messages, &tools, llm_turn, tool_rounds, progress).await?;
    llm_turn += 1;

    if !completed_round.tool_calls.is_empty() {
      if tool_rounds >= CHAT_MAX_TOOL_ROUNDS {
        return Err(format!("Chat tool loop exceeded maximum tool rounds ({CHAT_MAX_TOOL_ROUNDS}).").into());
      }

      tool_rounds += 1;
      messages.push(completed_round.assistant_message);
      let tool_messages = execute_chat_tool_round(
        db,
        session,
        uses_infumap_data,
        uses_web_search,
        completed_round.number,
        completed_round.tool_calls,
        progress,
      )
      .await?;
      messages.extend(tool_messages);
      continue;
    }

    messages.push(completed_round.assistant_message);
    let assistant_text = messages.last().and_then(|message| message.content.clone()).unwrap_or_default();
    if assistant_text.trim().is_empty() {
      return Err("llama-server returned an empty chat response.".into());
    }
    return Ok(ChatRunResult { assistant_text, messages: chat_history_from_llama_messages(&messages) });
  }
}

fn execution_tool_calls(message: &LlamaChatMessage, tool_round: usize) -> Vec<LlamaToolCall> {
  let Some(tool_calls) = &message.tool_calls else {
    return Vec::new();
  };

  tool_calls
    .iter()
    .enumerate()
    .map(|(index, tool_call)| {
      let mut execution_call = tool_call.clone();
      if execution_call.id.trim().is_empty() {
        execution_call.id = format!("call_{}_{}", tool_round + 1, index + 1);
      }
      if execution_call.tool_type.trim().is_empty() {
        execution_call.tool_type = default_llama_tool_call_type();
      }
      execution_call
    })
    .collect()
}

async fn execute_chat_tool_call(
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  tool_call: &LlamaToolCall,
  uses_infumap_data: bool,
  uses_web_search: bool,
) -> InfuResult<String> {
  match tool_call.function.name.as_str() {
    "lexical_search" | "get_fragment" if !uses_infumap_data => {
      Ok(tool_error_json("Infumap data is not enabled for this chat."))
    }
    "lexical_search" => execute_lexical_search_tool_call(db, session, tool_call).await,
    "get_fragment" => execute_get_fragment_tool_call(db, session, tool_call).await,
    "web_search" | "fetch_page" if !uses_web_search => Ok(tool_error_json("Web search is not enabled for this chat.")),
    "web_search" => execute_web_search_tool_call(tool_call).await,
    "fetch_page" => execute_fetch_page_tool_call(tool_call).await,
    name => Ok(tool_error_json(&format!("Unknown tool '{name}'."))),
  }
}

async fn execute_lexical_search_tool_call(
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  tool_call: &LlamaToolCall,
) -> InfuResult<String> {
  let arguments = match tool_call_arguments_value(tool_call) {
    Ok(arguments) => arguments,
    Err(e) => return Ok(tool_error_json(&e.to_string())),
  };
  let arguments: ChatLexicalSearchToolArguments = match serde_json::from_value(arguments) {
    Ok(arguments) => arguments,
    Err(e) => return Ok(tool_error_json(&format!("Could not parse lexical_search tool arguments: {}", e))),
  };

  let search_text = arguments.text.or(arguments.query).unwrap_or_default().trim().to_owned();
  if search_text.is_empty() {
    return Ok(tool_error_json("lexical_search tool argument 'text' is required."));
  }

  let num_results = arguments
    .num_results
    .unwrap_or(CHAT_LEXICAL_SEARCH_TOOL_DEFAULT_NUM_RESULTS)
    .clamp(1, CHAT_LEXICAL_SEARCH_TOOL_MAX_NUM_RESULTS);
  let page_num = arguments.page_num.map(|page_num| page_num.max(1));
  let search_request = search::SearchRequest { page_id: arguments.page_id, text: search_text, num_results, page_num };

  match search::run_lexical_search(db, search_request, session).await {
    Ok(response) => search::compact_search_response_json(&response),
    Err(e) => Ok(tool_error_json(&format!("lexical_search failed: {}", e))),
  }
}

async fn execute_get_fragment_tool_call(
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  tool_call: &LlamaToolCall,
) -> InfuResult<String> {
  let arguments = match tool_call_arguments_value(tool_call) {
    Ok(arguments) => arguments,
    Err(e) => return Ok(tool_error_json(&e.to_string())),
  };
  let arguments: ChatFragmentToolArguments = match serde_json::from_value(arguments) {
    Ok(arguments) => arguments,
    Err(e) => return Ok(tool_error_json(&format!("Could not parse get_fragment tool arguments: {}", e))),
  };

  let item_id = match arguments.item_id.as_deref().map(str::trim).filter(|item_id| !item_id.is_empty()) {
    Some(item_id) => item_id.to_owned(),
    None => return Ok(tool_error_json("get_fragment tool argument 'itemId' is required.")),
  };
  let fragment_ordinal = match arguments.fragment_ordinal.or(arguments.ordinal) {
    Some(ordinal) if ordinal >= 0 => ordinal as usize,
    Some(_) => return Ok(tool_error_json("get_fragment tool argument 'fragmentOrdinal' must be non-negative.")),
    None => return Ok(tool_error_json("get_fragment tool argument 'fragmentOrdinal' is required.")),
  };

  let (data_dir, item_type, title) = {
    let db = db.lock().await;
    let item = match db.item.get(&item_id) {
      Ok(item) => item,
      Err(_) => return Ok(tool_error_json("Item was not found.")),
    };
    if item.owner_id != session.user_id || item.item_type == ItemType::Password {
      return Ok(tool_error_json("Item was not found."));
    }
    (db.item.data_dir().to_owned(), item.item_type.as_str().to_owned(), item.title.clone())
  };

  let item_fragments: crate::ai::fragment::ItemFragments =
    match crate::ai::fragment::read_item_fragments(&data_dir, &session.user_id, &item_id).await {
      Ok(item_fragments) => item_fragments,
      Err(e) => return Ok(tool_error_json(&format!("Could not read item fragments: {}", e))),
    };
  let source_kind = item_fragments.source_kind;
  let selected_records: Vec<crate::ai::fragment::ItemFragmentRecord> =
    item_fragments.records.into_iter().filter(|record| record.ordinal == fragment_ordinal).collect::<Vec<_>>();

  if selected_records.is_empty() {
    return Ok(tool_error_json("Fragment ordinal was not found for this item."));
  }

  let mut remaining_chars = CHAT_FRAGMENT_TOOL_DEFAULT_MAX_CHARS;
  let mut text_truncated = false;
  let mut returned_fragments = Vec::new();
  for record in selected_records {
    if remaining_chars == 0 {
      text_truncated = true;
      break;
    }

    let (text, fragment_truncated) = clamp_text_chars(&record.text, remaining_chars);
    remaining_chars = remaining_chars.saturating_sub(text_char_count(&text));
    text_truncated |= fragment_truncated;
    returned_fragments.push(serde_json::json!({
      "fragmentOrdinal": record.ordinal,
      "text": text,
      "pageStart": record.page_start,
      "pageEnd": record.page_end,
      "textTruncated": fragment_truncated
    }));

    if fragment_truncated {
      break;
    }
  }

  Ok(
    serde_json::json!({
      "itemId": item_id,
      "linkUrl": format!("infumap://{}", item_id),
      "itemType": item_type,
      "title": title,
      "sourceKind": source_kind,
      "requestedFragmentOrdinal": fragment_ordinal,
      "fragments": returned_fragments,
      "textTruncated": text_truncated
    })
    .to_string(),
  )
}

async fn execute_web_search_tool_call(tool_call: &LlamaToolCall) -> InfuResult<String> {
  let arguments = match tool_call_arguments_value(tool_call) {
    Ok(arguments) => arguments,
    Err(e) => return Ok(tool_error_json(&e.to_string())),
  };
  let arguments: ChatWebSearchToolArguments = match serde_json::from_value(arguments) {
    Ok(arguments) => arguments,
    Err(e) => return Ok(tool_error_json(&format!("Could not parse web_search tool arguments: {}", e))),
  };

  let query = arguments.query.or(arguments.text).unwrap_or_default();
  if query.trim().is_empty() {
    return Ok(tool_error_json("web_search tool argument 'query' is required."));
  }

  let num_results = arguments
    .num_results
    .unwrap_or(web_search::DEFAULT_MAX_RESULTS as i64)
    .clamp(1, web_search::MAX_RESULTS_CAP as i64) as usize;

  match web_search::search_web_json(&query, num_results).await {
    Ok(response) => Ok(response),
    Err(e) => Ok(tool_error_json(&e.to_string())),
  }
}

async fn execute_fetch_page_tool_call(tool_call: &LlamaToolCall) -> InfuResult<String> {
  let arguments = match tool_call_arguments_value(tool_call) {
    Ok(arguments) => arguments,
    Err(e) => return Ok(tool_error_json(&e.to_string())),
  };
  let arguments: ChatFetchPageToolArguments = match serde_json::from_value(arguments) {
    Ok(arguments) => arguments,
    Err(e) => return Ok(tool_error_json(&format!("Could not parse fetch_page tool arguments: {}", e))),
  };

  let url = arguments.url.unwrap_or_default();
  if url.trim().is_empty() {
    return Ok(tool_error_json("fetch_page tool argument 'url' is required."));
  }

  let max_chars =
    arguments.max_chars.unwrap_or(web_search::DEFAULT_MAX_CHARS as i64).clamp(1, web_search::MAX_CHARS_CAP as i64)
      as usize;

  match web_search::fetch_page_json(&url, max_chars).await {
    Ok(response) => Ok(response),
    Err(e) => Ok(tool_error_json(&e.to_string())),
  }
}

fn tool_call_arguments_value(tool_call: &LlamaToolCall) -> InfuResult<Value> {
  match &tool_call.function.arguments {
    Value::String(arguments) if arguments.trim().is_empty() => Ok(serde_json::json!({})),
    Value::String(arguments) => serde_json::from_str(arguments).map_err(|e| {
      format!("Could not parse arguments for tool '{}': {}", tool_call.function.name, error_chain_for_log(&e)).into()
    }),
    Value::Object(_) => Ok(tool_call.function.arguments.clone()),
    Value::Null => Ok(serde_json::json!({})),
    other => Err(
      format!(
        "Tool '{}' arguments must be a JSON object or JSON-encoded object string, got: {}",
        tool_call.function.name, other
      )
      .into(),
    ),
  }
}

fn tool_error_json(message: &str) -> String {
  serde_json::json!({ "error": message }).to_string()
}

fn json_object_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
  value.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty())
}

fn json_object_string_raw(value: &Value, key: &str) -> Option<String> {
  value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn clipped_preview_text(text: &str) -> (String, bool) {
  clamp_text_chars(text, CHAT_TOOL_PREVIEW_TEXT_MAX_CHARS)
}

fn chat_tool_finished_activity(name: &str, arguments: &Value, result_json: &str) -> (String, Value) {
  let parsed = serde_json::from_str::<Value>(result_json).ok();
  if let Some(error) = parsed.as_ref().and_then(|value| json_object_str(value, "error")).map(str::to_owned) {
    return (error.clone(), serde_json::json!({ "error": error }));
  }

  match name {
    "lexical_search" => lexical_search_tool_activity(arguments, parsed.as_ref()),
    "get_fragment" => get_fragment_tool_activity(parsed.as_ref()),
    "web_search" => web_search_tool_activity(arguments, parsed.as_ref()),
    "fetch_page" => fetch_page_tool_activity(parsed.as_ref()),
    _ => (
      "Completed".to_owned(),
      parsed.unwrap_or_else(|| serde_json::json!({ "text": clipped_preview_text(result_json).0 })),
    ),
  }
}

fn lexical_search_tool_activity(arguments: &Value, parsed: Option<&Value>) -> (String, Value) {
  let query = json_object_str(arguments, "text").or_else(|| json_object_str(arguments, "query")).unwrap_or("");
  let results = parsed.and_then(|value| value.get("results")).and_then(Value::as_array);
  let result_count = results.map(Vec::len).unwrap_or(0);
  let has_more = parsed.and_then(|value| value.get("hasMore")).and_then(Value::as_bool).unwrap_or(false);
  let titles: Vec<&str> = results
    .iter()
    .flat_map(|arr| arr.iter())
    .filter_map(|result| json_object_str(result, "title"))
    .take(CHAT_TOOL_SUMMARY_TITLE_COUNT)
    .collect();

  let mut summary = String::new();
  if !query.is_empty() {
    let (clipped_query, _) = clamp_text_chars(query, CHAT_TOOL_SUMMARY_QUERY_MAX_CHARS);
    summary.push('"');
    summary.push_str(&clipped_query);
    summary.push_str("\" · ");
  }
  summary.push_str(&format!("{result_count} result{}", if result_count == 1 { "" } else { "s" }));
  if !titles.is_empty() {
    summary.push_str(" · ");
    summary.push_str(&titles.join(", "));
  }
  if has_more {
    summary.push_str(" · more");
  }

  let preview_results = results
    .iter()
    .flat_map(|arr| arr.iter())
    .map(|result| {
      let mut preview = serde_json::json!({
        "itemId": result.get("itemId").cloned().unwrap_or(Value::Null),
        "title": result.get("title").cloned().unwrap_or(Value::Null),
      });
      if let Some(fragment_match) = result.get("fragmentMatch") {
        preview["fragmentMatch"] = clipped_fragment_match_preview(fragment_match);
      }
      preview
    })
    .collect::<Vec<_>>();

  (summary, serde_json::json!({ "results": preview_results, "hasMore": has_more }))
}

fn web_search_tool_activity(arguments: &Value, parsed: Option<&Value>) -> (String, Value) {
  let query = json_object_str(arguments, "query").or_else(|| json_object_str(arguments, "text")).unwrap_or("");
  let results = parsed.and_then(|value| value.get("results")).and_then(Value::as_array);
  let result_count = results.map(Vec::len).unwrap_or(0);
  let titles: Vec<&str> = results
    .iter()
    .flat_map(|arr| arr.iter())
    .filter_map(|result| json_object_str(result, "title"))
    .take(CHAT_TOOL_SUMMARY_TITLE_COUNT)
    .collect();

  let mut summary = String::new();
  if !query.is_empty() {
    let (clipped_query, _) = clamp_text_chars(query, CHAT_TOOL_SUMMARY_QUERY_MAX_CHARS);
    summary.push('"');
    summary.push_str(&clipped_query);
    summary.push_str("\" · ");
  }
  summary.push_str(&format!("{result_count} result{}", if result_count == 1 { "" } else { "s" }));
  if !titles.is_empty() {
    summary.push_str(" · ");
    summary.push_str(&titles.join(", "));
  }

  let preview_results = results
    .iter()
    .flat_map(|arr| arr.iter())
    .map(|result| {
      serde_json::json!({
        "title": result.get("title").cloned().unwrap_or(Value::Null),
        "url": result.get("url").cloned().unwrap_or(Value::Null),
      })
    })
    .collect::<Vec<_>>();

  (summary, serde_json::json!({ "results": preview_results }))
}

fn fetch_page_tool_activity(parsed: Option<&Value>) -> (String, Value) {
  let Some(parsed) = parsed else {
    return ("Completed".to_owned(), serde_json::json!({}));
  };

  let url = json_object_str(parsed, "finalUrl").or_else(|| json_object_str(parsed, "url")).unwrap_or("");
  let truncated = parsed.get("truncated").and_then(Value::as_bool).unwrap_or(false);
  let host_changed = parsed.get("hostChanged").and_then(Value::as_bool).unwrap_or(false);
  let text = parsed.get("text").and_then(Value::as_str).unwrap_or("");
  let (clipped, clip_truncated) = clipped_preview_text(text);

  let mut summary = String::new();
  if !url.is_empty() {
    let (clipped_url, _) = clamp_text_chars(url, CHAT_TOOL_SUMMARY_QUERY_MAX_CHARS);
    summary.push_str(&clipped_url);
    summary.push_str(" · ");
  }
  if host_changed {
    summary.push_str("host changed · ");
  }
  if truncated || clip_truncated {
    summary.push_str("truncated");
  } else {
    summary.push_str("fetched");
  }

  (
    summary,
    serde_json::json!({
      "url": parsed.get("url").cloned().unwrap_or(Value::Null),
      "finalUrl": parsed.get("finalUrl").cloned().unwrap_or(Value::Null),
      "truncated": truncated,
      "hostChanged": host_changed,
      "text": clipped,
    }),
  )
}

fn clipped_fragment_match_preview(fragment_match: &Value) -> Value {
  let text = fragment_match.get("text").and_then(Value::as_str).unwrap_or("");
  let (clipped, clip_truncated) = clipped_preview_text(text);
  let already_truncated = fragment_match.get("textTruncated").and_then(Value::as_bool).unwrap_or(false);
  serde_json::json!({
    "fragmentOrdinal": fragment_match.get("fragmentOrdinal").cloned().unwrap_or(Value::Null),
    "text": clipped,
    "textTruncated": already_truncated || clip_truncated,
  })
}

fn get_fragment_tool_activity(parsed: Option<&Value>) -> (String, Value) {
  let Some(parsed) = parsed else {
    return ("Completed".to_owned(), serde_json::json!({}));
  };

  let title = json_object_str(parsed, "title");
  let ordinal = parsed.get("requestedFragmentOrdinal").and_then(Value::as_u64);
  let fragments = parsed.get("fragments").and_then(Value::as_array);
  let char_count = fragments
    .iter()
    .flat_map(|arr| arr.iter())
    .filter_map(|fragment| fragment.get("text").and_then(Value::as_str))
    .map(text_char_count)
    .sum::<usize>();
  let truncated = parsed.get("textTruncated").and_then(Value::as_bool).unwrap_or(false)
    || fragments
      .iter()
      .flat_map(|arr| arr.iter())
      .any(|fragment| fragment.get("textTruncated").and_then(Value::as_bool).unwrap_or(false));

  let mut summary = String::new();
  if let Some(title) = title {
    let (clipped_title, _) = clamp_text_chars(title, CHAT_TOOL_SUMMARY_QUERY_MAX_CHARS);
    summary.push('"');
    summary.push_str(&clipped_title);
    summary.push_str("\" · ");
  }
  if let Some(ordinal) = ordinal {
    summary.push_str(&format!("fragment {ordinal} · "));
  }
  summary.push_str(&format!("{char_count} chars"));
  if truncated {
    summary.push_str(", truncated");
  }

  let preview_fragments = fragments
    .iter()
    .flat_map(|arr| arr.iter())
    .map(|fragment| {
      let text = fragment.get("text").and_then(Value::as_str).unwrap_or("");
      let (clipped, clip_truncated) = clipped_preview_text(text);
      let already_truncated = fragment.get("textTruncated").and_then(Value::as_bool).unwrap_or(false);
      serde_json::json!({
        "fragmentOrdinal": fragment.get("fragmentOrdinal").cloned().unwrap_or(Value::Null),
        "text": clipped,
        "textTruncated": already_truncated || clip_truncated,
      })
    })
    .collect::<Vec<_>>();

  (
    summary,
    serde_json::json!({
      "title": parsed.get("title").cloned().unwrap_or(Value::Null),
      "requestedFragmentOrdinal": parsed.get("requestedFragmentOrdinal").cloned().unwrap_or(Value::Null),
      "textTruncated": truncated,
      "fragments": preview_fragments,
    }),
  )
}

#[derive(Default)]
struct LlamaStreamingToolCall {
  id: String,
  tool_type: String,
  name: String,
  arguments: String,
}

#[derive(Default)]
struct LlamaStreamingCompletion {
  completion_id: Option<String>,
  role: String,
  content: String,
  reasoning_content: String,
  tool_calls: Vec<Option<LlamaStreamingToolCall>>,
  finish_reason: Option<String>,
  usage: Option<LlamaChatCompletionUsage>,
  saw_choice: bool,
}

enum LlamaVisibleDelta {
  Reasoning(String),
  Answer(String),
}

impl LlamaStreamingCompletion {
  fn apply_chunk(&mut self, chunk: LlamaChatCompletionChunk) -> InfuResult<Vec<LlamaVisibleDelta>> {
    if let Some(error) = chunk.error {
      return Err(format!("llama-server returned a streaming error: {}", error).into());
    }
    if let Some(completion_id) = chunk.id {
      self.completion_id = Some(completion_id);
    }
    if let Some(usage) = chunk.usage {
      self.usage = Some(usage);
    }

    let mut visible_deltas = Vec::new();
    for choice in chunk.choices {
      if choice.index != 0 {
        continue;
      }
      self.saw_choice = true;
      if let Some(finish_reason) = choice.finish_reason.or(choice.delta.finish_reason.clone()) {
        self.finish_reason = Some(finish_reason);
      }
      if let Some(role) = choice.delta.role {
        self.role = role;
      }
      if let Some(reasoning_content) = choice.delta.reasoning_content {
        self.reasoning_content.push_str(&reasoning_content);
        if !reasoning_content.is_empty() {
          visible_deltas.push(LlamaVisibleDelta::Reasoning(reasoning_content));
        }
      }
      if let Some(content) = choice.delta.content {
        self.content.push_str(&content);
        if !content.is_empty() {
          visible_deltas.push(LlamaVisibleDelta::Answer(content));
        }
      }
      for tool_call_delta in choice.delta.tool_calls {
        if self.tool_calls.len() <= tool_call_delta.index {
          self.tool_calls.resize_with(tool_call_delta.index + 1, || None);
        }
        let tool_call = self.tool_calls[tool_call_delta.index].get_or_insert_with(Default::default);
        if let Some(id) = tool_call_delta.id {
          tool_call.id.push_str(&id);
        }
        if let Some(tool_type) = tool_call_delta.tool_type {
          tool_call.tool_type.push_str(&tool_type);
        }
        if let Some(function) = tool_call_delta.function {
          if let Some(name) = function.name {
            tool_call.name.push_str(&name);
          }
          if let Some(arguments) = function.arguments {
            tool_call.arguments.push_str(&arguments);
          }
        }
      }
    }

    Ok(visible_deltas)
  }

  fn response_log_value(&self) -> Value {
    serde_json::json!({
      "id": self.completion_id,
      "role": if self.role.is_empty() { "assistant" } else { self.role.as_str() },
      "reasoning_content": self.reasoning_content,
      "content": self.content,
      "tool_calls": self.tool_calls.iter().filter_map(|tool_call| tool_call.as_ref()).map(|tool_call| {
        serde_json::json!({
          "id": tool_call.id,
          "type": tool_call.tool_type,
          "function": {
            "name": tool_call.name,
            "arguments": tool_call.arguments,
          }
        })
      }).collect::<Vec<_>>(),
      "finish_reason": self.finish_reason,
      "stream_done": true,
    })
  }

  fn into_message(self) -> InfuResult<LlamaChatMessage> {
    if !self.saw_choice {
      return Err("llama-server returned no chat response choices.".into());
    }

    let tool_calls = self
      .tool_calls
      .into_iter()
      .flatten()
      .map(|tool_call| LlamaToolCall {
        id: tool_call.id,
        tool_type: tool_call.tool_type,
        function: LlamaToolCallFunction { name: tool_call.name, arguments: Value::String(tool_call.arguments) },
      })
      .collect::<Vec<_>>();

    Ok(LlamaChatMessage {
      role: if self.role.is_empty() { "assistant".to_owned() } else { self.role },
      content: if self.content.is_empty() { None } else { Some(self.content) },
      reasoning_content: if self.reasoning_content.is_empty() { None } else { Some(self.reasoning_content) },
      tool_call_id: None,
      tool_calls: if tool_calls.is_empty() { None } else { Some(tool_calls) },
    })
  }
}

#[derive(Default)]
struct LlamaSseDecoder {
  pending_bytes: Vec<u8>,
  data_lines: Vec<String>,
}

impl LlamaSseDecoder {
  fn push(&mut self, bytes: &[u8]) -> InfuResult<Vec<String>> {
    self.pending_bytes.extend_from_slice(bytes);
    self.consume_complete_lines(false)
  }

  fn finish(&mut self) -> InfuResult<Vec<String>> {
    self.consume_complete_lines(true)
  }

  fn consume_complete_lines(&mut self, flush: bool) -> InfuResult<Vec<String>> {
    let mut events = Vec::new();
    let mut consumed = 0usize;
    while let Some(relative_newline) = self.pending_bytes[consumed..].iter().position(|byte| *byte == b'\n') {
      let newline = consumed + relative_newline;
      process_llama_sse_line(&self.pending_bytes[consumed..newline], &mut self.data_lines, &mut events)?;
      consumed = newline + 1;
    }
    if consumed > 0 {
      self.pending_bytes.drain(..consumed);
    }

    if flush {
      if !self.pending_bytes.is_empty() {
        process_llama_sse_line(&self.pending_bytes, &mut self.data_lines, &mut events)?;
        self.pending_bytes.clear();
      }
      dispatch_llama_sse_event(&mut self.data_lines, &mut events);
    }

    Ok(events)
  }
}

fn process_llama_sse_line(raw_line: &[u8], data_lines: &mut Vec<String>, events: &mut Vec<String>) -> InfuResult<()> {
  let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
  let line = std::str::from_utf8(raw_line)
    .map_err(|e| format!("llama-server SSE response contained invalid UTF-8: {}", error_chain_for_log(&e)))?;
  if line.is_empty() {
    dispatch_llama_sse_event(data_lines, events);
    return Ok(());
  }
  if line.starts_with(':') {
    return Ok(());
  }

  let (field, value) = line.split_once(':').unwrap_or((line, ""));
  if field == "data" {
    data_lines.push(value.strip_prefix(' ').unwrap_or(value).to_owned());
  }
  Ok(())
}

fn dispatch_llama_sse_event(data_lines: &mut Vec<String>, events: &mut Vec<String>) {
  if !data_lines.is_empty() {
    events.push(std::mem::take(data_lines).join("\n"));
  }
}

struct AppliedLlamaSseData {
  done: bool,
  visible_deltas: Vec<LlamaVisibleDelta>,
}

fn apply_llama_sse_data(data: &str, completion: &mut LlamaStreamingCompletion) -> InfuResult<AppliedLlamaSseData> {
  let trimmed = data.trim();
  if trimmed.is_empty() {
    return Ok(AppliedLlamaSseData { done: false, visible_deltas: Vec::new() });
  }
  if trimmed == "[DONE]" {
    return Ok(AppliedLlamaSseData { done: true, visible_deltas: Vec::new() });
  }

  let chunk: LlamaChatCompletionChunk = serde_json::from_str(trimmed).map_err(|e| {
    format!(
      "Could not parse llama-server SSE data as a chat completion chunk: {}. Data: {}",
      error_chain_for_log(&e),
      truncate_for_error(trimmed, 1000),
    )
  })?;
  let visible_deltas = completion.apply_chunk(chunk)?;
  Ok(AppliedLlamaSseData { done: false, visible_deltas })
}

async fn apply_llama_sse_events(
  events: Vec<String>,
  completion: &mut LlamaStreamingCompletion,
  round: usize,
  progress: &ChatProgressReporter,
) -> InfuResult<bool> {
  for data in events {
    let applied = apply_llama_sse_data(&data, completion)?;
    for delta in applied.visible_deltas {
      match delta {
        LlamaVisibleDelta::Reasoning(text) => progress.reasoning_delta(round, text).await,
        LlamaVisibleDelta::Answer(text) => progress.answer_delta(round, text).await,
      }
    }
    if applied.done {
      return Ok(true);
    }
  }
  Ok(false)
}

async fn llama_chat_completion(
  config: &Config,
  messages: &[LlamaChatMessage],
  tools: &[LlamaToolSpec],
  llm_turn: usize,
  progress: &ChatProgressReporter,
) -> InfuResult<LlamaChatMessage> {
  let url = configured_llama_chat_url(config)?;

  let client = reqwest::ClientBuilder::new()
    .connect_timeout(Duration::from_secs(CHAT_LLAMA_CONNECT_TIMEOUT_SECS))
    .read_timeout(Duration::from_secs(CHAT_LLAMA_READ_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build llama-server HTTP client: {}", reqwest_error_for_log(&e)))?;
  let payload = LlamaChatCompletionRequest {
    model: "default".to_owned(),
    messages: messages.to_vec(),
    stream: true,
    stream_options: Some(LlamaStreamOptions { include_usage: true }),
    tools: tools.to_vec(),
  };
  append_llm_request_metrics_log(llm_turn, messages, tools);
  append_llm_json_log_section(&format!("LLM REQUEST {}", llm_turn), &payload);
  progress.context_tokens(approx_request_tokens(messages, tools), false).await;
  let response = client
    .post(url.clone())
    .header(reqwest::header::ACCEPT, "text/event-stream")
    .json(&payload)
    .send()
    .await
    .map_err(|e| format!("Could not send chat request to llama-server '{}': {}", url, reqwest_error_for_log(&e)))?;

  let status = response.status();
  if !status.is_success() {
    let body = response
      .text()
      .await
      .map_err(|e| format!("Could not read llama-server error response body: {}", reqwest_error_for_log(&e)))?;
    append_llm_log_section(&format!("LLM RESPONSE {}", llm_turn), &body);
    return Err(
      format!("llama-server chat endpoint '{}' returned {}: {}", url, status, truncate_for_error(&body, 1000)).into(),
    );
  }

  let mut response_stream = response.bytes_stream();
  let mut decoder = LlamaSseDecoder::default();
  let mut completion = LlamaStreamingCompletion::default();
  let mut saw_done = false;
  while let Some(chunk) = futures_util::StreamExt::next(&mut response_stream).await {
    let chunk =
      chunk.map_err(|e| format!("Could not read llama-server SSE response body: {}", reqwest_error_for_log(&e)))?;
    saw_done = apply_llama_sse_events(decoder.push(&chunk)?, &mut completion, llm_turn, progress).await?;
    if saw_done {
      break;
    }
  }
  if !saw_done {
    saw_done = apply_llama_sse_events(decoder.finish()?, &mut completion, llm_turn, progress).await?;
  }
  if !saw_done {
    return Err("llama-server SSE response ended before the [DONE] event.".into());
  }

  append_llm_json_log_section(&format!("LLM RESPONSE {}", llm_turn), &completion.response_log_value());
  if let Some(usage) = completion.usage.as_ref() {
    append_llm_json_log_section(&format!("LLM RESPONSE USAGE {}", llm_turn), usage);
    if let Some(prompt_tokens) = usage.prompt_tokens {
      progress.context_tokens(prompt_tokens, true).await;
    }
  }
  completion.into_message()
}

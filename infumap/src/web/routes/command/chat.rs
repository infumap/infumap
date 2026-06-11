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
use std::io::Write as _;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::web::serve::empty_body;

const CHAT_LLAMA_REQUEST_TIMEOUT_SECS: u64 = 120;
const CHAT_MAX_TOOL_ROUNDS: usize = 3;
const CHAT_HISTORY_MAX_PREVIOUS_MESSAGES: usize = 8;
const CHAT_HISTORY_MAX_MESSAGE_CHARS: usize = 4_000;
const CHAT_HISTORY_MAX_TOTAL_CHARS: usize = 12_000;
const CHAT_SEARCH_TOOL_DEFAULT_NUM_RESULTS: i64 = 8;
const CHAT_SEARCH_TOOL_MAX_NUM_RESULTS: i64 = 20;
const CHAT_FRAGMENT_TOOL_DEFAULT_MAX_CHARS: usize = 2_500;
const CHAT_FRAGMENT_TOOL_MAX_CHARS: usize = 6_000;
const CHAT_FRAGMENT_TOOL_MAX_CONTEXT_FRAGMENTS: usize = 2;
const CHAT_RESPONSE_ITEM_WIDTH_GR: i64 = 30 * GRID_SIZE;
const CHAT_RESPONSE_TABLE_MAX_HEIGHT_BL: i64 = 12;
const CHAT_RESPONSE_TABLE_MIN_COLUMN_WIDTH_GR: i64 = 3 * GRID_SIZE;
const CHAT_RESPONSE_TABLE_TEXT_SCORE_CAP: usize = 120;
const CHAT_RESPONSE_TABLE_LONG_WORD_SCORE_CAP: usize = 40;
const LLM_LOG_PATH: &str = "/tmp/llm.txt";
const CHAT_SYSTEM_PROMPT: &str = "\
You are Infumap's chat assistant.

Use the search tool when the user asks about information that may be stored in Infumap.
Search returns compact results with item ids, item types, titles, paths, fragment ordinals, and text snippets.
Use get_fragment when a search snippet is truncated, ambiguous, or too small to answer from confidently.
If search results are insufficient, say what is missing rather than inventing details.
Return a concise Markdown answer.";
const NOTE_FLAG_HEADING3: i64 = 0x001;
const NOTE_FLAG_HEADING1: i64 = 0x004;
const NOTE_FLAG_HEADING2: i64 = 0x008;
const NOTE_FLAG_BULLET1: i64 = 0x010;
const NOTE_FLAG_CODE: i64 = 0x200;
const NOTE_FLAG_HEADING4: i64 = 0x1000;
const NOTE_FLAG_NUMBERED: i64 = 0x8000;
const NOTE_INLINE_MARK_BOLD: i64 = 0x001;
const NOTE_INLINE_MARK_ITALIC: i64 = 0x002;
const TABLE_FLAG_SHOW_COL_HEADER: i64 = 0x001;
const TABLE_FLAG_HIDE_TITLE: i64 = 0x002;

#[derive(Deserialize)]
struct ChatRequest {
  #[serde(rename = "contextItems")]
  context_items: Vec<Value>,
  #[serde(rename = "userText")]
  user_text: String,
}

#[derive(Serialize)]
struct ChatStreamEvent {
  #[serde(rename = "type")]
  event_type: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  text: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  summary: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  items: Option<Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  message: Option<String>,
}

impl ChatStreamEvent {
  fn status(text: &str) -> Self {
    Self {
      event_type: "status".to_owned(),
      text: Some(text.to_owned()),
      name: None,
      summary: None,
      items: None,
      message: None,
    }
  }

  fn tool_call_started(name: &str) -> Self {
    Self {
      event_type: "tool_call_started".to_owned(),
      text: None,
      name: Some(name.to_owned()),
      summary: None,
      items: None,
      message: None,
    }
  }

  fn tool_call_finished(name: &str, summary: &str) -> Self {
    Self {
      event_type: "tool_call_finished".to_owned(),
      text: None,
      name: Some(name.to_owned()),
      summary: Some(summary.to_owned()),
      items: None,
      message: None,
    }
  }

  fn final_items(items: Value) -> Self {
    Self {
      event_type: "final_items".to_owned(),
      text: None,
      name: None,
      summary: None,
      items: Some(items),
      message: None,
    }
  }

  fn error(message: &str) -> Self {
    Self {
      event_type: "error".to_owned(),
      text: None,
      name: None,
      summary: None,
      items: None,
      message: Some(message.to_owned()),
    }
  }
}

#[derive(Clone)]
struct ChatProgressReporter {
  tx: mpsc::Sender<Result<Frame<Bytes>, hyper::Error>>,
}

impl ChatProgressReporter {
  async fn send(&self, event: ChatStreamEvent) {
    let line = match serde_json::to_string(&event) {
      Ok(line) => format!("{line}\n"),
      Err(_) => "{\"type\":\"error\",\"message\":\"Could not serialize chat stream event.\"}\n".to_owned(),
    };
    let _ = self.tx.send(Ok(Frame::data(Bytes::from(line)))).await;
  }

  async fn status(&self, text: &str) {
    self.send(ChatStreamEvent::status(text)).await;
  }

  async fn tool_call_started(&self, name: &str) {
    self.send(ChatStreamEvent::tool_call_started(name)).await;
  }

  async fn tool_call_finished(&self, name: &str, summary: &str) {
    self.send(ChatStreamEvent::tool_call_finished(name, summary)).await;
  }
}

#[derive(Clone, Deserialize, Serialize)]
struct LlamaChatMessage {
  #[serde(default)]
  role: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  content: Option<String>,
  #[serde(rename = "tool_call_id", skip_serializing_if = "Option::is_none")]
  tool_call_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  tool_calls: Option<Vec<LlamaToolCall>>,
}

impl LlamaChatMessage {
  fn text(role: &str, content: String) -> Self {
    Self { role: role.to_owned(), content: Some(content), tool_call_id: None, tool_calls: None }
  }

  fn tool(tool_call_id: String, content: String) -> Self {
    Self { role: "tool".to_owned(), content: Some(content), tool_call_id: Some(tool_call_id), tool_calls: None }
  }
}

#[derive(Clone, Deserialize, Serialize)]
struct LlamaToolCall {
  #[serde(default)]
  id: String,
  #[serde(rename = "type", default = "default_llama_tool_call_type")]
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
struct LlamaChatCompletionRequest {
  model: String,
  messages: Vec<LlamaChatMessage>,
  stream: bool,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  tools: Vec<LlamaToolSpec>,
}

#[derive(Deserialize)]
struct LlamaChatCompletionResponse {
  choices: Vec<LlamaChatCompletionChoice>,
  usage: Option<LlamaChatCompletionUsage>,
}

#[derive(Deserialize)]
struct LlamaChatCompletionChoice {
  message: LlamaChatMessage,
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
struct ChatSearchToolArguments {
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
  before: Option<i64>,
  after: Option<i64>,
  #[serde(rename = "maxChars")]
  max_chars: Option<i64>,
}

pub(super) async fn handle_chat(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = match session_maybe {
    Some(session) => session,
    None => {
      return Err(format!("Session is required to run a chat query.").into());
    }
  };

  let request: ChatRequest =
    serde_json::from_str(json_data).map_err(|e| format!("Could not parse chat request: {}", e))?;
  let assistant_text = run_chat_with_tools(config, db, session, &request).await?;

  Ok(Some(chat_response_items_json(&session.user_id, &assistant_text).to_string()))
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

  let session_maybe = get_and_validate_session(&request, db).await;
  let session = match session_maybe {
    Some(session) => session,
    None => {
      return single_chat_stream_event_response(ChatStreamEvent::error("Session is required to run a chat query."));
    }
  };

  let request: ChatRequest = match incoming_json_with_limit(request, COMMAND_REQUEST_MAX_BYTES).await {
    Ok(request) => request,
    Err(e) => {
      error!("An error occurred parsing chat stream payload for user '{}': {}", session.user_id, e);
      return single_chat_stream_event_response(ChatStreamEvent::error("Could not parse chat request."));
    }
  };

  let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, hyper::Error>>(16);
  let progress = ChatProgressReporter { tx: tx.clone() };
  let user_id = session.user_id.clone();
  let db = db.clone();

  tokio::spawn(async move {
    progress.status("Preparing context").await;
    let result = run_chat_with_tools_with_progress(config, &db, &session, &request, Some(&progress)).await;
    match result {
      Ok(assistant_text) => {
        progress.status("Preparing response").await;
        let response = chat_response_items_json(&user_id, &assistant_text);
        let items = response.get("items").cloned().unwrap_or_else(|| Value::Array(Vec::new()));
        progress.send(ChatStreamEvent::final_items(items)).await;
      }
      Err(e) => {
        warn!("An error occurred servicing a streaming chat request for user '{}': {}.", user_id, e);
        progress.send(ChatStreamEvent::error("Chat failed.")).await;
      }
    }
  });

  chat_stream_response(rx)
}

fn single_chat_stream_event_response(event: ChatStreamEvent) -> Response<BoxBody<Bytes, hyper::Error>> {
  let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, hyper::Error>>(1);
  tokio::spawn(async move {
    let reporter = ChatProgressReporter { tx };
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

fn clamp_message_content(message: &mut LlamaChatMessage, max_chars: usize) {
  let Some(content) = message.content.as_mut() else {
    return;
  };
  let (clamped, _) = clamp_text_chars(content.trim(), max_chars);
  *content = clamped;
}

fn message_content_chars(message: &LlamaChatMessage) -> usize {
  message.content.as_deref().map(text_char_count).unwrap_or(0)
}

fn total_message_content_chars(messages: &[LlamaChatMessage]) -> usize {
  messages.iter().map(message_content_chars).sum()
}

fn trim_chat_messages_for_prompt(
  previous_messages: Vec<LlamaChatMessage>,
  current_user_text: String,
) -> Vec<LlamaChatMessage> {
  let skip_count = previous_messages.len().saturating_sub(CHAT_HISTORY_MAX_PREVIOUS_MESSAGES);
  let mut messages = previous_messages.into_iter().skip(skip_count).collect::<Vec<_>>();
  for message in &mut messages {
    clamp_message_content(message, CHAT_HISTORY_MAX_MESSAGE_CHARS);
  }

  let current_user_text = current_user_text.trim();
  if !current_user_text.is_empty() {
    let (content, _) = clamp_text_chars(current_user_text, CHAT_HISTORY_MAX_MESSAGE_CHARS);
    messages.push(LlamaChatMessage::text("user", content));
  }

  while messages.len() > 1 && total_message_content_chars(&messages) > CHAT_HISTORY_MAX_TOTAL_CHARS {
    messages.remove(0);
  }

  messages
}

fn llama_messages_from_chat_request(request: &ChatRequest) -> Vec<LlamaChatMessage> {
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

  trim_chat_messages_for_prompt(messages, request.user_text.clone())
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
  match std::fs::OpenOptions::new().create(true).append(true).open(LLM_LOG_PATH) {
    Ok(mut file) => {
      if let Err(e) = writeln!(file, "\n===== {} =====\n{}", title, body) {
        warn!("Could not write LLM log '{}': {}", LLM_LOG_PATH, e);
      }
    }
    Err(e) => warn!("Could not open LLM log '{}': {}", LLM_LOG_PATH, e),
  }
}

fn append_llm_json_log_section<T: Serialize>(title: &str, value: &T) {
  let body =
    serde_json::to_string_pretty(value).unwrap_or_else(|e| format!("Could not serialize LLM log value: {}", e));
  append_llm_log_section(title, &body);
}

fn append_llm_request_metrics_log(llm_turn: usize, messages: &[LlamaChatMessage], tools: &[LlamaToolSpec]) {
  let content_chars = total_message_content_chars(messages);
  let tool_schema_chars = serde_json::to_string(tools).map(|text| text_char_count(&text)).unwrap_or(0);
  let total_request_chars = content_chars + tool_schema_chars;
  let tool_result_chars =
    messages.iter().filter(|message| message.role == "tool").map(message_content_chars).sum::<usize>();
  let metrics = serde_json::json!({
    "messageCount": messages.len(),
    "toolCount": tools.len(),
    "contentChars": content_chars,
    "toolSchemaChars": tool_schema_chars,
    "totalRequestChars": total_request_chars,
    "approxContentTokens": (content_chars + 3) / 4,
    "approxRequestTokens": (total_request_chars + 3) / 4,
    "toolResultChars": tool_result_chars
  });
  append_llm_json_log_section(&format!("LLM REQUEST METRICS {}", llm_turn), &metrics);
}

fn search_tool_spec() -> LlamaToolSpec {
  LlamaToolSpec {
    tool_type: "function".to_owned(),
    function: LlamaToolFunctionSpec {
      name: "search".to_owned(),
      description: "Search the user's Infumap items using the same behavior as the search UI.".to_owned(),
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "text": {
            "type": "string",
            "description": "Search query text."
          },
          "pageId": {
            "type": ["string", "null"],
            "description": "Optional Infumap page id to search within. Use null or omit it to search the user's home scope."
          },
          "numResults": {
            "type": "integer",
            "minimum": 1,
            "maximum": CHAT_SEARCH_TOOL_MAX_NUM_RESULTS,
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
      description: "Fetch bounded full text for a specific Infumap search fragment by item id and fragment ordinal."
        .to_owned(),
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "itemId": {
            "type": "string",
            "description": "Item id from a search result."
          },
          "fragmentOrdinal": {
            "type": "integer",
            "minimum": 0,
            "description": "Fragment ordinal from a search result."
          },
          "before": {
            "type": "integer",
            "minimum": 0,
            "maximum": CHAT_FRAGMENT_TOOL_MAX_CONTEXT_FRAGMENTS,
            "description": "Optional number of preceding fragments to include."
          },
          "after": {
            "type": "integer",
            "minimum": 0,
            "maximum": CHAT_FRAGMENT_TOOL_MAX_CONTEXT_FRAGMENTS,
            "description": "Optional number of following fragments to include."
          },
          "maxChars": {
            "type": "integer",
            "minimum": 1,
            "maximum": CHAT_FRAGMENT_TOOL_MAX_CHARS,
            "description": "Maximum text characters to return across all fetched fragments."
          }
        },
        "required": ["itemId", "fragmentOrdinal"],
        "additionalProperties": false
      }),
    },
  }
}

async fn run_chat_with_tools(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  request: &ChatRequest,
) -> InfuResult<String> {
  run_chat_with_tools_with_progress(config, db, session, request, None).await
}

async fn run_chat_with_tools_with_progress(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  request: &ChatRequest,
  progress: Option<&ChatProgressReporter>,
) -> InfuResult<String> {
  reset_llm_log();

  let mut messages = llama_messages_from_chat_request(request);
  if messages.is_empty() {
    return Err("Chat request did not contain any message text.".into());
  }
  messages.insert(0, LlamaChatMessage::text("system", CHAT_SYSTEM_PROMPT.to_owned()));

  let tools = vec![search_tool_spec(), get_fragment_tool_spec()];
  let mut llm_turn = 1usize;
  let mut tool_rounds = 0usize;

  loop {
    if let Some(progress) = progress {
      progress.status("Asking model").await;
    }
    let mut message = llama_chat_completion(config.as_ref(), &messages, &tools, llm_turn).await?;
    llm_turn += 1;
    if message.role.trim().is_empty() {
      message.role = "assistant".to_owned();
    }

    let tool_calls = normalize_tool_calls(&mut message, tool_rounds);
    if !tool_calls.is_empty() {
      if tool_rounds >= CHAT_MAX_TOOL_ROUNDS {
        return Err(format!("Chat tool loop exceeded maximum tool rounds ({CHAT_MAX_TOOL_ROUNDS}).").into());
      }

      tool_rounds += 1;
      messages.push(message);
      for tool_call in tool_calls {
        if let Some(progress) = progress {
          progress.tool_call_started(&tool_call.function.name).await;
        }
        let tool_result = execute_chat_tool_call(config.clone(), db, session, &tool_call).await?;
        if let Some(progress) = progress {
          progress.tool_call_finished(&tool_call.function.name, "Done").await;
        }
        append_llm_log_section(&format!("TOOL RESULT {} {}", tool_call.function.name, tool_call.id), &tool_result);
        messages.push(LlamaChatMessage::tool(tool_call.id.clone(), tool_result));
      }
      continue;
    }

    let content = message.content.unwrap_or_default().trim().to_owned();
    if content.is_empty() {
      return Err("llama-server returned an empty chat response.".into());
    }
    return Ok(content);
  }
}

fn normalize_tool_calls(message: &mut LlamaChatMessage, tool_round: usize) -> Vec<LlamaToolCall> {
  let Some(tool_calls) = message.tool_calls.as_mut() else {
    return Vec::new();
  };

  for (index, tool_call) in tool_calls.iter_mut().enumerate() {
    if tool_call.id.trim().is_empty() {
      tool_call.id = format!("call_{}_{}", tool_round + 1, index + 1);
    }
    if tool_call.tool_type.trim().is_empty() {
      tool_call.tool_type = "function".to_owned();
    }
  }

  tool_calls.clone()
}

async fn execute_chat_tool_call(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  tool_call: &LlamaToolCall,
) -> InfuResult<String> {
  match tool_call.function.name.as_str() {
    "search" => execute_search_tool_call(config, db, session, tool_call).await,
    "get_fragment" => execute_get_fragment_tool_call(config, db, session, tool_call).await,
    name => Ok(tool_error_json(&format!("Unknown tool '{name}'."))),
  }
}

async fn execute_search_tool_call(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  tool_call: &LlamaToolCall,
) -> InfuResult<String> {
  let arguments = match tool_call_arguments_value(tool_call) {
    Ok(arguments) => arguments,
    Err(e) => return Ok(tool_error_json(&e.to_string())),
  };
  let arguments: ChatSearchToolArguments = match serde_json::from_value(arguments) {
    Ok(arguments) => arguments,
    Err(e) => return Ok(tool_error_json(&format!("Could not parse search tool arguments: {}", e))),
  };

  let search_text = arguments.text.or(arguments.query).unwrap_or_default().trim().to_owned();
  if search_text.is_empty() {
    return Ok(tool_error_json("Search tool argument 'text' is required."));
  }

  let num_results =
    arguments.num_results.unwrap_or(CHAT_SEARCH_TOOL_DEFAULT_NUM_RESULTS).clamp(1, CHAT_SEARCH_TOOL_MAX_NUM_RESULTS);
  let page_num = arguments.page_num.map(|page_num| page_num.max(1));
  let search_request = search::SearchRequest { page_id: arguments.page_id, text: search_text, num_results, page_num };

  match search::run_search(config, db, search_request, session).await {
    Ok(response) => search::compact_search_response_json(&response),
    Err(e) => Ok(tool_error_json(&format!("Search failed: {}", e))),
  }
}

async fn execute_get_fragment_tool_call(
  _config: Arc<Config>,
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
  let before = fragment_context_arg(arguments.before);
  let after = fragment_context_arg(arguments.after);
  let max_chars = arguments
    .max_chars
    .unwrap_or(CHAT_FRAGMENT_TOOL_DEFAULT_MAX_CHARS as i64)
    .clamp(1, CHAT_FRAGMENT_TOOL_MAX_CHARS as i64) as usize;

  let (data_dir, item_type, title) = {
    let db = db.lock().await;
    let item = match db.item.get(&item_id) {
      Ok(item) => item,
      Err(_) => return Ok(tool_error_json("Item was not found.")),
    };
    if item.owner_id != session.user_id {
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
  let start_ordinal = fragment_ordinal.saturating_sub(before);
  let end_ordinal = fragment_ordinal.saturating_add(after);
  let selected_records: Vec<crate::ai::fragment::ItemFragmentRecord> = item_fragments
    .records
    .into_iter()
    .filter(|record| record.ordinal >= start_ordinal && record.ordinal <= end_ordinal)
    .collect::<Vec<_>>();

  if selected_records.is_empty() {
    return Ok(tool_error_json("Fragment ordinal was not found for this item."));
  }

  let mut remaining_chars = max_chars;
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

fn fragment_context_arg(value: Option<i64>) -> usize {
  value.unwrap_or(0).clamp(0, CHAT_FRAGMENT_TOOL_MAX_CONTEXT_FRAGMENTS as i64) as usize
}

fn tool_call_arguments_value(tool_call: &LlamaToolCall) -> InfuResult<Value> {
  match &tool_call.function.arguments {
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

async fn llama_chat_completion(
  config: &Config,
  messages: &[LlamaChatMessage],
  tools: &[LlamaToolSpec],
  llm_turn: usize,
) -> InfuResult<LlamaChatMessage> {
  let url = configured_llama_chat_url(config)?;

  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(CHAT_LLAMA_REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build llama-server HTTP client: {}", reqwest_error_for_log(&e)))?;
  let payload = LlamaChatCompletionRequest {
    model: "default".to_owned(),
    messages: messages.to_vec(),
    stream: false,
    tools: tools.to_vec(),
  };
  append_llm_request_metrics_log(llm_turn, messages, tools);
  append_llm_json_log_section(&format!("LLM REQUEST {}", llm_turn), &payload);
  let response = client
    .post(url.clone())
    .json(&payload)
    .send()
    .await
    .map_err(|e| format!("Could not send chat request to llama-server '{}': {}", url, reqwest_error_for_log(&e)))?;

  let status = response.status();
  let body = response
    .text()
    .await
    .map_err(|e| format!("Could not read llama-server response body: {}", reqwest_error_for_log(&e)))?;
  append_llm_log_section(&format!("LLM RESPONSE {}", llm_turn), &body);
  if !status.is_success() {
    return Err(
      format!("llama-server chat endpoint '{}' returned {}: {}", url, status, truncate_for_error(&body, 1000)).into(),
    );
  }

  let parsed: LlamaChatCompletionResponse = serde_json::from_str(&body)
    .map_err(|e| format!("Could not parse llama-server chat response: {}", error_chain_for_log(&e)))?;
  if let Some(usage) = parsed.usage.as_ref() {
    append_llm_json_log_section(&format!("LLM RESPONSE USAGE {}", llm_turn), usage);
  }
  parsed
    .choices
    .into_iter()
    .next()
    .map(|choice| choice.message)
    .ok_or_else(|| "llama-server returned no chat response choices.".into())
}

struct ChatMarkdownNote {
  title: String,
  flags: i64,
  inline_marks: Vec<i64>,
}

#[derive(Clone)]
struct ChatMarkdownInlineText {
  title: String,
  inline_marks: Vec<i64>,
}

struct ChatMarkdownTableRow {
  cells: Vec<ChatMarkdownInlineText>,
}

struct ChatMarkdownTable {
  columns: Vec<String>,
  rows: Vec<ChatMarkdownTableRow>,
}

enum ChatMarkdownItem {
  Note(ChatMarkdownNote),
  Divider,
  Table(ChatMarkdownTable),
}

fn chat_response_items_json(owner_id: &Uid, assistant_text: &str) -> Value {
  let now = unix_now_secs_u64().unwrap();
  let composite_id = new_uid();
  let mut parsed_items = chat_markdown_items_from_text(assistant_text);

  if parsed_items.is_empty() {
    push_chat_markdown_note(&mut parsed_items, assistant_text, 0);
  }

  let mut items = Vec::with_capacity(parsed_items.len() + 1);
  items.push(serde_json::json!({
    "itemType": "composite",
    "ownerId": owner_id,
    "id": composite_id.clone(),
    "parentId": null,
    "relationshipToParent": "child",
    "groupId": null,
    "creationDate": now,
    "lastModifiedDate": now,
    "dateTime": now,
    "ordering": [],
    "spatialPositionGr": { "x": 0, "y": 0 },
    "spatialWidthGr": CHAT_RESPONSE_ITEM_WIDTH_GR,
    "title": "Assistant",
    "flags": 0x002,
    "orderChildrenBy": "",
  }));

  let mut child_orderings: Vec<Vec<u8>> = Vec::new();
  for parsed_item in parsed_items {
    let ordering = new_ordering_at_end(child_orderings.clone());
    child_orderings.push(ordering.clone());
    match parsed_item {
      ChatMarkdownItem::Note(note) => {
        items.push(chat_response_note_json(owner_id, &composite_id, "child", now, ordering, new_uid(), note))
      }
      ChatMarkdownItem::Divider => items.push(chat_response_divider_json(owner_id, &composite_id, now, ordering)),
      ChatMarkdownItem::Table(table) => {
        items.extend(chat_response_table_json(owner_id, &composite_id, now, ordering, table))
      }
    }
  }

  serde_json::json!({ "items": items })
}

fn chat_response_note_json(
  owner_id: &Uid,
  parent_id: &Uid,
  relationship_to_parent: &str,
  now: u64,
  ordering: Vec<u8>,
  item_id: Uid,
  note: ChatMarkdownNote,
) -> Value {
  serde_json::json!({
      "itemType": "note",
      "ownerId": owner_id,
      "id": item_id,
      "parentId": parent_id,
      "relationshipToParent": relationship_to_parent,
      "groupId": null,
      "creationDate": now,
      "lastModifiedDate": now,
      "dateTime": now,
      "ordering": ordering,
      "title": note.title,
      "spatialPositionGr": { "x": 0, "y": 0 },
      "spatialWidthGr": CHAT_RESPONSE_ITEM_WIDTH_GR,
      "spatialHeightGr": 0,
      "flags": note.flags,
      "urls": [],
      "emoji": null,
      "iconMode": "auto",
      "inlineMarks": note.inline_marks,
  })
}

fn chat_response_divider_json(owner_id: &Uid, parent_id: &Uid, now: u64, ordering: Vec<u8>) -> Value {
  serde_json::json!({
      "itemType": "divider",
      "ownerId": owner_id,
      "id": new_uid(),
      "parentId": parent_id,
      "relationshipToParent": "child",
      "groupId": null,
      "creationDate": now,
      "lastModifiedDate": now,
      "dateTime": now,
      "ordering": ordering,
      "spatialPositionGr": { "x": 0, "y": 0 },
      "spatialWidthGr": CHAT_RESPONSE_ITEM_WIDTH_GR,
      "spatialHeightGr": GRID_SIZE,
      "dividerDirection": "horizontal",
  })
}

fn chat_response_table_json(
  owner_id: &Uid,
  parent_id: &Uid,
  now: u64,
  ordering: Vec<u8>,
  table: ChatMarkdownTable,
) -> Vec<Value> {
  let table_id = new_uid();
  let column_widths_gr = chat_response_table_column_widths_gr(CHAT_RESPONSE_ITEM_WIDTH_GR, &table);
  let row_count = table.rows.len() as i64;
  let mut items = vec![serde_json::json!({
      "itemType": "table",
      "ownerId": owner_id,
      "id": table_id.clone(),
      "parentId": parent_id,
      "relationshipToParent": "child",
      "groupId": null,
      "creationDate": now,
      "lastModifiedDate": now,
      "dateTime": now,
      "ordering": ordering,
      "title": "",
      "spatialPositionGr": { "x": 0, "y": 0 },
      "spatialWidthGr": CHAT_RESPONSE_ITEM_WIDTH_GR,
      "spatialHeightGr": row_count.saturating_add(1).clamp(3, CHAT_RESPONSE_TABLE_MAX_HEIGHT_BL) * GRID_SIZE,
      "flags": TABLE_FLAG_SHOW_COL_HEADER | TABLE_FLAG_HIDE_TITLE,
      "tableColumns": table.columns.iter().enumerate().map(|(index, column)| {
        serde_json::json!({
          "name": column,
          "widthGr": column_widths_gr.get(index).copied().unwrap_or(GRID_SIZE),
        })
      }).collect::<Vec<Value>>(),
      "numberOfVisibleColumns": table.columns.len() as i64,
      "orderChildrenBy": "",
  })];

  let mut row_orderings: Vec<Vec<u8>> = Vec::new();
  for row in table.rows {
    let row_ordering = new_ordering_at_end(row_orderings.clone());
    row_orderings.push(row_ordering.clone());

    let row_id = new_uid();
    let first_cell = row.cells.first().cloned().unwrap_or_else(empty_chat_markdown_inline_text);
    items.push(chat_response_note_json(
      owner_id,
      &table_id,
      "child",
      now,
      row_ordering,
      row_id.clone(),
      ChatMarkdownNote { title: first_cell.title, flags: 0, inline_marks: first_cell.inline_marks },
    ));

    let mut attachment_orderings: Vec<Vec<u8>> = Vec::new();
    let last_cell_index = last_non_empty_chat_table_attachment_cell_index(&row);
    for cell_index in 1..=last_cell_index {
      let attachment_ordering = new_ordering_at_end(attachment_orderings.clone());
      attachment_orderings.push(attachment_ordering.clone());
      let cell = row.cells.get(cell_index).cloned().unwrap_or_else(empty_chat_markdown_inline_text);
      if cell.title.trim().is_empty() {
        items.push(chat_response_placeholder_json(owner_id, &row_id, now, attachment_ordering));
      } else {
        items.push(chat_response_note_json(
          owner_id,
          &row_id,
          "attachment",
          now,
          attachment_ordering,
          new_uid(),
          ChatMarkdownNote { title: cell.title, flags: 0, inline_marks: cell.inline_marks },
        ));
      }
    }
  }

  items
}

fn chat_response_placeholder_json(owner_id: &Uid, parent_id: &Uid, now: u64, ordering: Vec<u8>) -> Value {
  serde_json::json!({
      "itemType": "placeholder",
      "ownerId": owner_id,
      "id": new_uid(),
      "parentId": parent_id,
      "relationshipToParent": "attachment",
      "groupId": null,
      "creationDate": now,
      "lastModifiedDate": now,
      "dateTime": now,
      "ordering": ordering,
  })
}

fn empty_chat_markdown_inline_text() -> ChatMarkdownInlineText {
  ChatMarkdownInlineText { title: "".to_owned(), inline_marks: Vec::new() }
}

fn last_non_empty_chat_table_attachment_cell_index(row: &ChatMarkdownTableRow) -> usize {
  for index in (1..row.cells.len()).rev() {
    if !row.cells[index].title.trim().is_empty() {
      return index;
    }
  }
  0
}

fn integer_column_widths_gr(total_width_gr: i64, column_count: usize) -> Vec<i64> {
  let safe_column_count = column_count.max(1);
  let integer_total_width_gr = total_width_gr.max(1);
  let base_width_gr = integer_total_width_gr / safe_column_count as i64;
  let remainder_gr = integer_total_width_gr - base_width_gr * safe_column_count as i64;
  (0..safe_column_count).map(|index| base_width_gr + if index < remainder_gr as usize { 1 } else { 0 }).collect()
}

fn weighted_integer_column_widths_gr(total_width_gr: i64, weights: &[f64], min_width_gr: i64) -> Vec<i64> {
  if weights.is_empty() {
    return Vec::new();
  }

  let integer_total_width_gr = total_width_gr.max(1);
  let safe_weights: Vec<f64> = weights.iter().map(|w| if w.is_finite() && *w > 0.0 { *w } else { 1.0 }).collect();
  let total_weight: f64 = safe_weights.iter().sum();
  if total_weight <= 0.0 {
    return integer_column_widths_gr(integer_total_width_gr, weights.len());
  }

  let integer_min_width_gr = min_width_gr.max(0);
  let effective_min_width_gr = integer_min_width_gr.min(integer_total_width_gr / weights.len() as i64);
  let remaining_width_gr = integer_total_width_gr - effective_min_width_gr * weights.len() as i64;
  let exact_widths_gr: Vec<f64> = safe_weights
    .iter()
    .map(|w| effective_min_width_gr as f64 + remaining_width_gr as f64 * *w / total_weight)
    .collect();
  let mut integer_widths_gr: Vec<i64> = exact_widths_gr.iter().map(|w| w.floor() as i64).collect();
  let remainder_gr = integer_total_width_gr - integer_widths_gr.iter().sum::<i64>();
  let mut fractional_order: Vec<(usize, f64)> =
    exact_widths_gr.iter().enumerate().map(|(index, width)| (index, width - width.floor())).collect();
  fractional_order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));

  for index in 0..remainder_gr as usize {
    integer_widths_gr[fractional_order[index % fractional_order.len()].0] += 1;
  }

  integer_widths_gr
}

fn chat_table_cell_text_width_score(text: &str) -> f64 {
  let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
  if normalized.is_empty() {
    return 0.0;
  }

  let longest_word_length = normalized.split_whitespace().map(|word| word.encode_utf16().count()).max().unwrap_or(0);
  let capped_text_length = normalized.encode_utf16().count().min(CHAT_RESPONSE_TABLE_TEXT_SCORE_CAP);
  let capped_longest_word_length = longest_word_length.min(CHAT_RESPONSE_TABLE_LONG_WORD_SCORE_CAP);
  capped_text_length as f64 * 0.7 + capped_longest_word_length as f64 * 1.3
}

fn chat_table_column_text_weight(table: &ChatMarkdownTable, column_index: usize) -> f64 {
  let mut scores =
    vec![chat_table_cell_text_width_score(table.columns.get(column_index).map(String::as_str).unwrap_or(""))];
  for row in &table.rows {
    scores.push(chat_table_cell_text_width_score(
      row.cells.get(column_index).map(|cell| cell.title.as_str()).unwrap_or(""),
    ));
  }

  let non_empty_scores: Vec<f64> = scores.into_iter().filter(|score| *score > 0.0).collect();
  if non_empty_scores.is_empty() {
    return 1.0;
  }

  let max_score = non_empty_scores.iter().copied().fold(0.0, f64::max);
  let average_score = non_empty_scores.iter().sum::<f64>() / non_empty_scores.len() as f64;
  (max_score * 0.75 + average_score * 0.25).powf(0.8)
}

fn chat_response_table_column_widths_gr(total_width_gr: i64, table: &ChatMarkdownTable) -> Vec<i64> {
  let weights: Vec<f64> =
    table.columns.iter().enumerate().map(|(index, _)| chat_table_column_text_weight(table, index)).collect();
  weighted_integer_column_widths_gr(total_width_gr, &weights, CHAT_RESPONSE_TABLE_MIN_COLUMN_WIDTH_GR)
}

fn chat_markdown_items_from_text(markdown: &str) -> Vec<ChatMarkdownItem> {
  let mut items = Vec::new();
  let mut paragraph_lines: Vec<String> = Vec::new();
  let lines: Vec<&str> = markdown.lines().collect();
  let mut line_index = 0;

  while line_index < lines.len() {
    let line = lines[line_index];

    if line.trim().is_empty() {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      line_index += 1;
      continue;
    }

    if let Some(fence_marker) = markdown_code_fence_marker(line) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      line_index += 1;
      let mut code_lines = Vec::new();
      while line_index < lines.len() {
        let code_line = lines[line_index];
        if code_line.trim_start().starts_with(fence_marker) {
          break;
        }
        code_lines.push(code_line.to_owned());
        line_index += 1;
      }
      if line_index < lines.len() {
        line_index += 1;
      }
      push_chat_markdown_note(&mut items, &code_lines.join("\n"), NOTE_FLAG_CODE);
      continue;
    }

    if let Some((table, next_line_index)) = markdown_table_at(&lines, line_index) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      items.push(ChatMarkdownItem::Table(table));
      line_index = next_line_index;
      continue;
    }

    if markdown_divider_line(line) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      items.push(ChatMarkdownItem::Divider);
      line_index += 1;
      continue;
    }

    if let Some((flags, title)) = markdown_heading(line) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      push_chat_markdown_note(&mut items, title, flags);
      line_index += 1;
      continue;
    }

    if let Some((flags, title)) = markdown_list_item(line) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      push_chat_markdown_note(&mut items, title, flags);
      line_index += 1;
      continue;
    }

    if markdown_standalone_inline_heading(line) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      push_chat_markdown_note(&mut items, line, 0);
      line_index += 1;
      continue;
    }

    paragraph_lines.push(line.to_owned());
    line_index += 1;
  }

  flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
  items
}

fn flush_chat_markdown_paragraph(items: &mut Vec<ChatMarkdownItem>, paragraph_lines: &mut Vec<String>) {
  if paragraph_lines.is_empty() {
    return;
  }
  let paragraph = paragraph_lines.join("\n");
  paragraph_lines.clear();
  push_chat_markdown_note(items, &paragraph, 0);
}

fn push_chat_markdown_note(items: &mut Vec<ChatMarkdownItem>, raw_title: &str, flags: i64) {
  let title =
    if flags & NOTE_FLAG_CODE != 0 { raw_title.trim_matches('\n').to_owned() } else { raw_title.trim().to_owned() };
  if title.is_empty() {
    return;
  }

  let (title, inline_marks) =
    if flags & NOTE_FLAG_CODE != 0 { (title, Vec::new()) } else { parse_markdown_inline(&title) };
  if title.trim().is_empty() {
    return;
  }

  items.push(ChatMarkdownItem::Note(ChatMarkdownNote { title, flags, inline_marks }));
}

fn markdown_code_fence_marker(line: &str) -> Option<&'static str> {
  let trimmed = line.trim_start();
  if trimmed.starts_with("```") {
    Some("```")
  } else if trimmed.starts_with("~~~") {
    Some("~~~")
  } else {
    None
  }
}

fn markdown_table_at(lines: &[&str], index: usize) -> Option<(ChatMarkdownTable, usize)> {
  if index + 1 >= lines.len() {
    return None;
  }

  let header_cells = split_markdown_table_row(lines[index])?;
  let separator_cells = split_markdown_table_row(lines[index + 1])?;
  if separator_cells.len() < header_cells.len() || !markdown_table_separator_row(&separator_cells) {
    return None;
  }

  let column_count = header_cells.len();
  let mut rows = Vec::new();
  let mut row_index = index + 2;
  while row_index < lines.len() {
    let Some(row_cells) = split_markdown_table_row(lines[row_index]) else {
      break;
    };
    if markdown_table_separator_row(&row_cells) {
      break;
    }
    rows.push(ChatMarkdownTableRow { cells: normalize_markdown_table_inline_cells(&row_cells, column_count) });
    row_index += 1;
  }

  Some((
    ChatMarkdownTable {
      columns: normalize_markdown_table_cells(&header_cells, column_count)
        .iter()
        .map(|cell| parse_markdown_inline(cell).0)
        .collect(),
      rows,
    },
    row_index,
  ))
}

fn split_markdown_table_row(line: &str) -> Option<Vec<String>> {
  let mut body = line.trim();
  if body.is_empty() {
    return None;
  }

  if body.starts_with('|') {
    body = &body[1..];
  }
  if body.ends_with('|') && (body.len() < 2 || !body[..body.len() - 1].ends_with('\\')) {
    body = &body[..body.len() - 1];
  }

  let mut cells = Vec::new();
  let mut cell = String::new();
  let mut saw_separator = false;
  let mut chars = body.chars().peekable();
  while let Some(ch) = chars.next() {
    if ch == '\\' && chars.peek() == Some(&'|') {
      cell.push('|');
      chars.next();
      continue;
    }
    if ch == '|' {
      cells.push(cell.trim().to_owned());
      cell.clear();
      saw_separator = true;
      continue;
    }
    cell.push(ch);
  }
  cells.push(cell.trim().to_owned());

  if !saw_separator || cells.len() < 2 {
    return None;
  }
  Some(cells)
}

fn markdown_table_separator_cell(cell: &str) -> bool {
  let trimmed = cell.trim();
  let body = trimmed.strip_prefix(':').unwrap_or(trimmed);
  let body = body.strip_suffix(':').unwrap_or(body);
  body.len() >= 3 && body.chars().all(|ch| ch == '-')
}

fn markdown_table_separator_row(cells: &[String]) -> bool {
  cells.len() >= 2 && cells.iter().all(|cell| markdown_table_separator_cell(cell))
}

fn normalize_markdown_table_cells(cells: &[String], column_count: usize) -> Vec<String> {
  let mut result = cells.iter().take(column_count).cloned().collect::<Vec<_>>();
  while result.len() < column_count {
    result.push("".to_owned());
  }
  result
}

fn normalize_markdown_table_inline_cells(cells: &[String], column_count: usize) -> Vec<ChatMarkdownInlineText> {
  normalize_markdown_table_cells(cells, column_count)
    .iter()
    .map(|cell| {
      let (title, inline_marks) = parse_markdown_inline(cell);
      ChatMarkdownInlineText { title, inline_marks }
    })
    .collect()
}

fn markdown_divider_line(line: &str) -> bool {
  let chars: Vec<char> = line.chars().filter(|c| !c.is_whitespace()).collect();
  if chars.len() < 3 {
    return false;
  }
  let divider_char = chars[0];
  matches!(divider_char, '-' | '_' | '*') && chars.iter().all(|c| *c == divider_char)
}

fn markdown_heading(line: &str) -> Option<(i64, &str)> {
  let trimmed = line.trim_start();
  let heading_level = trimmed.chars().take_while(|c| *c == '#').count();
  if heading_level == 0 || heading_level > 6 {
    return None;
  }
  let title = &trimmed[heading_level..];
  if !title.chars().next().map(|c| c.is_whitespace()).unwrap_or(false) {
    return None;
  }
  let title = title.trim();
  if title.is_empty() {
    return None;
  }
  Some((
    match heading_level {
      1 => NOTE_FLAG_HEADING1,
      2 => NOTE_FLAG_HEADING2,
      3 => NOTE_FLAG_HEADING3,
      _ => NOTE_FLAG_HEADING4,
    },
    title,
  ))
}

fn markdown_list_item(line: &str) -> Option<(i64, &str)> {
  let trimmed = line.trim_start();
  let mut chars = trimmed.char_indices();
  if let Some((_, marker)) = chars.next() {
    if matches!(marker, '-' | '*' | '+') {
      if let Some((content_start, separator)) = chars.next() {
        if separator.is_whitespace() {
          return Some((NOTE_FLAG_BULLET1, trimmed[content_start..].trim_start()));
        }
      }
    }
  }

  let mut digit_end = 0;
  let mut has_digit = false;
  for (index, ch) in trimmed.char_indices() {
    if !ch.is_ascii_digit() {
      break;
    }
    has_digit = true;
    digit_end = index + ch.len_utf8();
  }
  if !has_digit || !trimmed[digit_end..].starts_with('.') {
    return None;
  }

  let content = &trimmed[digit_end + 1..];
  if !content.chars().next().map(|c| c.is_whitespace()).unwrap_or(false) {
    return None;
  }
  Some((NOTE_FLAG_NUMBERED, content.trim_start()))
}

fn markdown_standalone_inline_heading(line: &str) -> bool {
  let trimmed = line.trim();
  for marker in ["***", "___", "**", "__"] {
    if trimmed.len() > marker.len() * 2 && trimmed.starts_with(marker) && trimmed.ends_with(marker) {
      return true;
    }
  }
  false
}

fn parse_markdown_inline(input: &str) -> (String, Vec<i64>) {
  let mut output = String::new();
  let mut inline_marks = Vec::new();
  let mut index = 0;

  while index < input.len() {
    if let Some((escaped, len)) = markdown_escaped_ascii_punctuation(&input[index..]) {
      output.push(escaped);
      index += len;
      continue;
    }

    if input[index..].starts_with("`") {
      let content_start = index + 1;
      if let Some(content_end) = input[content_start..].find('`').map(|offset| content_start + offset) {
        output.push_str(&input[content_start..content_end]);
        index = content_end + 1;
        continue;
      }
    }

    if let Some((marker, flags)) = markdown_inline_marker(&input[index..]) {
      let content_start = index + marker.len();
      if let Some(content_end) = input[content_start..].find(marker).map(|offset| content_start + offset) {
        if content_end > content_start {
          append_chat_marked_inline_text(&mut output, &mut inline_marks, &input[content_start..content_end], flags);
          index = content_end + marker.len();
          continue;
        }
      }
    }

    let ch = input[index..].chars().next().unwrap();
    output.push(ch);
    index += ch.len_utf8();
  }

  (output, inline_marks)
}

fn markdown_escaped_ascii_punctuation(slice: &str) -> Option<(char, usize)> {
  let mut chars = slice.chars();
  if chars.next()? != '\\' {
    return None;
  }

  let escaped = chars.next()?;
  if !escaped.is_ascii_punctuation() {
    return None;
  }

  Some((escaped, '\\'.len_utf8() + escaped.len_utf8()))
}

fn markdown_inline_marker(slice: &str) -> Option<(&'static str, i64)> {
  for (marker, flags) in [
    ("***", NOTE_INLINE_MARK_BOLD | NOTE_INLINE_MARK_ITALIC),
    ("___", NOTE_INLINE_MARK_BOLD | NOTE_INLINE_MARK_ITALIC),
    ("**", NOTE_INLINE_MARK_BOLD),
    ("__", NOTE_INLINE_MARK_BOLD),
    ("*", NOTE_INLINE_MARK_ITALIC),
    ("_", NOTE_INLINE_MARK_ITALIC),
  ] {
    if slice.starts_with(marker) {
      return Some((marker, flags));
    }
  }
  None
}

fn append_chat_marked_inline_text(output: &mut String, inline_marks: &mut Vec<i64>, text: &str, flags: i64) {
  let start = output.encode_utf16().count() as i64;
  append_chat_markdown_unescaped_text(output, text);
  let end = output.encode_utf16().count() as i64;
  push_chat_inline_mark(inline_marks, start, end, flags);
}

fn append_chat_markdown_unescaped_text(output: &mut String, text: &str) {
  let mut index = 0;
  while index < text.len() {
    if let Some((escaped, len)) = markdown_escaped_ascii_punctuation(&text[index..]) {
      output.push(escaped);
      index += len;
      continue;
    }

    let ch = text[index..].chars().next().unwrap();
    output.push(ch);
    index += ch.len_utf8();
  }
}

fn push_chat_inline_mark(inline_marks: &mut Vec<i64>, start: i64, end: i64, flags: i64) {
  if start >= end || flags == 0 {
    return;
  }
  if inline_marks.len() >= 3 {
    let last_start_index = inline_marks.len() - 3;
    let last_end = inline_marks[last_start_index + 1];
    let last_flags = inline_marks[last_start_index + 2];
    if start < last_end {
      return;
    }
    if start == last_end && flags == last_flags {
      inline_marks[last_start_index + 1] = end;
      return;
    }
  }

  inline_marks.extend([start, end, flags]);
}

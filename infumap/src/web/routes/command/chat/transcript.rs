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

//! Live chat transcripts: one JSONL file per query item in the Queries page, at
//! `user_{id}/chats/{query_item_id}.chat`. The file is the authoritative transcript of the chat.
//! See docs/persistent-chats.md.
//!
//! Each append is one complete newline-terminated record, followed by a sync. A reader ignores an
//! incomplete last line; taking the chat lock truncates it before anything else is appended.
//! Readers do not take the lock.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use infusdk::util::infu::InfuResult;
use infusdk::util::uid::{Uid, is_uid};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::OwnedMutexGuard;

use super::backend::ChatModelSelection;
use super::{ChatHistoryMessage, ChatRunMode};
use crate::ai::artifact_io::atomic_write;
use crate::util::fs::expand_tilde;

pub(super) const TRANSCRIPT_FORMAT_VERSION: u32 = 1;
const CHATS_DIR_NAME: &str = "chats";

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TranscriptRecord {
  Header(TranscriptHeader),
  User(UserRecord),
  Turn(TurnRecord),
}

/// The first line of the file, and only there.
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct TranscriptHeader {
  pub(super) version: u32,
  /// The query item the transcript was created for. A persisted `.chat` item keeps it, but it is not
  /// that item's id.
  #[serde(rename = "queryItemId")]
  pub(super) query_item_id: Uid,
  /// Unix time in milliseconds.
  #[serde(rename = "createdAt")]
  pub(super) created_at: i64,
}

/// The settings a turn ran with. They are per turn because they can change between turns.
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct TurnSettings {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub(super) model: Option<ChatModelSelection>,
  #[serde(default)]
  pub(super) capabilities: Vec<String>,
  #[serde(rename = "scopeId", default, skip_serializing_if = "Option::is_none")]
  pub(super) scope_id: Option<Uid>,
  pub(super) mode: ChatRunMode,
}

/// Written, and synced, before inference starts.
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct UserRecord {
  #[serde(rename = "requestId")]
  pub(super) request_id: String,
  /// Unix time in milliseconds.
  #[serde(rename = "startedAt")]
  pub(super) started_at: i64,
  pub(super) text: String,
  pub(super) settings: TurnSettings,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum TurnOutcome {
  Completed,
  /// Includes a client disconnect.
  Cancelled,
  Error,
}

/// Written, and synced, when a turn ends, before completion is reported.
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct TurnRecord {
  #[serde(rename = "requestId")]
  pub(super) request_id: String,
  /// The assistant and tool messages the turn added to the model history. Empty unless completed.
  #[serde(default)]
  pub(super) messages: Vec<ChatHistoryMessage>,
  /// Activity for the turn dropdown, including partial rounds of an unsuccessful turn.
  #[serde(default)]
  pub(super) rounds: Vec<ActivityRound>,
  /// Unix time in milliseconds.
  #[serde(rename = "startedAt")]
  pub(super) started_at: i64,
  /// Unix time in milliseconds.
  #[serde(rename = "endedAt")]
  pub(super) ended_at: i64,
  pub(super) outcome: TurnOutcome,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub(super) error: Option<String>,
}

/// One model round, in the shape of the client's `QueryChatActivityModelRound`.
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct ActivityRound {
  pub(super) number: usize,
  #[serde(default)]
  pub(super) reasoning: String,
  #[serde(default)]
  pub(super) answer: String,
  #[serde(rename = "toolCalls", default)]
  pub(super) tool_calls: Vec<ActivityToolCall>,
  pub(super) complete: bool,
}

/// One tool call, in the shape of the client's `QueryChatActivityToolCall`.
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct ActivityToolCall {
  #[serde(rename = "callId")]
  pub(super) call_id: String,
  pub(super) name: String,
  pub(super) status: ActivityToolCallStatus,
  #[serde(default)]
  pub(super) summary: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub(super) arguments: Option<Value>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub(super) query: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub(super) url: Option<String>,
  #[serde(rename = "durationMs", default, skip_serializing_if = "Option::is_none")]
  pub(super) duration_ms: Option<u64>,
  #[serde(rename = "resultPreview", default, skip_serializing_if = "Option::is_none")]
  pub(super) result_preview: Option<Value>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ActivityToolCallStatus {
  Running,
  Complete,
  AwaitingApproval,
}

pub(super) struct Transcript {
  pub(super) header: TranscriptHeader,
  pub(super) turns: Vec<TranscriptTurn>,
}

pub(super) struct TranscriptTurn {
  pub(super) user: UserRecord,
  /// None while the turn runs, or if the server stopped before the turn ended.
  pub(super) end: Option<TurnRecord>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TurnStatus {
  Running,
  Completed,
  Cancelled,
  Error,
  /// The turn never ended, and is not running: the server stopped during it.
  Interrupted,
}

impl Transcript {
  /// The number of `user` records. Title changes and turn ends do not advance it.
  pub(super) fn revision(&self) -> usize {
    self.turns.len()
  }

  /// `turn_running` is whether a turn holds the chat lock now. Only the last turn can be running;
  /// an earlier turn without an end was interrupted. Derived on read: nothing is written for it.
  pub(super) fn turn_status(&self, index: usize, turn_running: bool) -> TurnStatus {
    let turn = &self.turns[index];
    match &turn.end {
      Some(end) => match end.outcome {
        TurnOutcome::Completed => TurnStatus::Completed,
        TurnOutcome::Cancelled => TurnStatus::Cancelled,
        TurnOutcome::Error => TurnStatus::Error,
      },
      None if turn_running && index + 1 == self.turns.len() => TurnStatus::Running,
      None => TurnStatus::Interrupted,
    }
  }

  /// The model history: the user message and added messages of completed turns only. An unsuccessful
  /// turn contributes nothing, not even its user message, so the history never has two user
  /// messages in a row.
  pub(super) fn history(&self) -> Vec<ChatHistoryMessage> {
    let mut messages = vec![];
    for turn in &self.turns {
      let Some(end) = &turn.end else { continue };
      if end.outcome != TurnOutcome::Completed {
        continue;
      }
      messages.push(ChatHistoryMessage {
        role: "user".to_owned(),
        content: Some(turn.user.text.clone()),
        reasoning_content: None,
        tool_call_id: None,
        tool_calls: None,
      });
      messages.extend(end.messages.iter().cloned());
    }
    messages
  }

  fn check(&self, record: &TranscriptRecord) -> InfuResult<()> {
    match record {
      TranscriptRecord::Header(_) => Err("A transcript header is only allowed on the first line.".into()),
      TranscriptRecord::User(_) => Ok(()),
      TranscriptRecord::Turn(turn) => match self.turns.last() {
        Some(last) if last.end.is_none() && last.user.request_id == turn.request_id => Ok(()),
        _ => Err(format!("Turn record '{}' does not end the last turn.", turn.request_id).into()),
      },
    }
  }

  fn apply(&mut self, record: TranscriptRecord) -> InfuResult<()> {
    self.check(&record)?;
    match record {
      TranscriptRecord::Header(_) => unreachable!(),
      TranscriptRecord::User(user) => self.turns.push(TranscriptTurn { user, end: None }),
      TranscriptRecord::Turn(turn) => self.turns.last_mut().unwrap().end = Some(turn),
    }
    Ok(())
  }
}

pub(super) fn transcript_path(data_dir: &str, user_id: &Uid, query_item_id: &Uid) -> InfuResult<PathBuf> {
  if !is_uid(user_id) || !is_uid(query_item_id) {
    return Err(format!("Invalid transcript id '{}' for user '{}'.", query_item_id, user_id).into());
  }
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push(CHATS_DIR_NAME);
  path.push(format!("{}.chat", query_item_id));
  Ok(path)
}

/// The length of the complete records: everything up to and including the last newline.
fn complete_len(bytes: &[u8]) -> usize {
  bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |index| index + 1)
}

/// Parses the complete records. None if there is not even a complete header line. A malformed record
/// before the last line is an error, never skipped.
fn parse_transcript(bytes: &[u8]) -> InfuResult<Option<Transcript>> {
  let complete = &bytes[..complete_len(bytes)];
  if complete.is_empty() {
    return Ok(None);
  }
  let mut lines = complete[..complete.len() - 1].split(|byte| *byte == b'\n').enumerate();
  let mut transcript = match lines.next().map(|(_, line)| serde_json::from_slice::<TranscriptRecord>(line)) {
    Some(Ok(TranscriptRecord::Header(header))) => {
      if header.version != TRANSCRIPT_FORMAT_VERSION {
        return Err(format!("Unsupported transcript format version {}.", header.version).into());
      }
      Transcript { header, turns: vec![] }
    }
    Some(Ok(_)) => return Err("A transcript must start with a header record.".into()),
    Some(Err(e)) => return Err(format!("Malformed transcript header: {}", e).into()),
    None => return Ok(None),
  };
  for (index, line) in lines {
    let record = serde_json::from_slice::<TranscriptRecord>(line)
      .map_err(|e| format!("Malformed transcript record on line {}: {}", index + 1, e))?;
    transcript.apply(record).map_err(|e| format!("Transcript line {}: {}", index + 1, e))?;
  }
  Ok(Some(transcript))
}

/// Reads a transcript without the chat lock. A record being appended concurrently is an incomplete
/// last line and is ignored.
pub(super) async fn read_transcript(
  data_dir: &str,
  user_id: &Uid,
  query_item_id: &Uid,
) -> InfuResult<Option<Transcript>> {
  let path = transcript_path(data_dir, user_id, query_item_id)?;
  let bytes = match fs::read(&path).await {
    Ok(bytes) => bytes,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(e.into()),
  };
  parse_transcript(&bytes)
}

type ChatLockKey = (Uid, Uid);

fn chat_locks() -> &'static Mutex<HashMap<ChatLockKey, Weak<tokio::sync::Mutex<()>>>> {
  static LOCKS: OnceLock<Mutex<HashMap<ChatLockKey, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
  LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn chat_lock(user_id: &Uid, query_item_id: &Uid) -> Arc<tokio::sync::Mutex<()>> {
  let mut locks = chat_locks().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let key = (user_id.clone(), query_item_id.clone());
  if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
    return lock;
  }
  locks.retain(|_, lock| lock.strong_count() > 0);
  let lock = Arc::new(tokio::sync::Mutex::new(()));
  locks.insert(key, Arc::downgrade(&lock));
  lock
}

/// Whether the chat lock is held: a turn is running, or, briefly, a persist or delete.
pub(super) fn chat_is_locked(user_id: &Uid, query_item_id: &Uid) -> bool {
  let locks = chat_locks().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let key = (user_id.clone(), query_item_id.clone());
  locks.get(&key).and_then(Weak::upgrade).is_some_and(|lock| lock.try_lock().is_err())
}

/// Takes the chat lock, or returns None if it is held. A turn holds it for its whole length, and a
/// second turn, a persist or a delete is rejected rather than queued. Truncates an incomplete last
/// line left by a failed append before anything else can be appended.
pub(super) async fn try_lock_transcript(
  data_dir: &str,
  user_id: &Uid,
  query_item_id: &Uid,
) -> InfuResult<Option<LockedTranscript>> {
  let path = transcript_path(data_dir, user_id, query_item_id)?;
  let Ok(guard) = chat_lock(user_id, query_item_id).try_lock_owned() else {
    return Ok(None);
  };
  let bytes = match fs::read(&path).await {
    Ok(bytes) => bytes,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
    Err(e) => return Err(e.into()),
  };
  let transcript = parse_transcript(&bytes)?;
  let complete_len = complete_len(&bytes);
  if transcript.is_some() && complete_len < bytes.len() {
    let file = fs::OpenOptions::new().write(true).open(&path).await?;
    file.set_len(complete_len as u64).await?;
    file.sync_all().await?;
  }
  Ok(Some(LockedTranscript { _guard: guard, path, transcript, failed: false }))
}

/// A transcript under the chat lock.
pub(super) struct LockedTranscript {
  _guard: OwnedMutexGuard<()>,
  path: PathBuf,
  /// None if the file does not exist, or has no complete header line.
  transcript: Option<Transcript>,
  /// Set when a write fails, after which the file may not match `transcript`. Taking the lock again
  /// re-reads and repairs it.
  failed: bool,
}

impl LockedTranscript {
  pub(super) fn transcript(&self) -> Option<&Transcript> {
    self.transcript.as_ref()
  }

  /// Creates the file with its header, atomically and synced. A file without a complete header line
  /// is replaced.
  pub(super) async fn create(&mut self, header: TranscriptHeader) -> InfuResult<()> {
    if self.transcript.is_some() {
      return Err(format!("Transcript '{}' already exists.", self.path.display()).into());
    }
    if header.version != TRANSCRIPT_FORMAT_VERSION {
      return Err(format!("Unsupported transcript format version {}.", header.version).into());
    }
    let line = record_line(&TranscriptRecord::Header(header.clone()))?;
    atomic_write(&self.path, line.as_bytes()).await?;
    self.transcript = Some(Transcript { header, turns: vec![] });
    Ok(())
  }

  pub(super) async fn append_user(&mut self, user: UserRecord) -> InfuResult<()> {
    self.append(TranscriptRecord::User(user)).await
  }

  /// Ends the last turn, which must have the same request id and must not have ended.
  pub(super) async fn append_turn(&mut self, turn: TurnRecord) -> InfuResult<()> {
    self.append(TranscriptRecord::Turn(turn)).await
  }

  async fn append(&mut self, record: TranscriptRecord) -> InfuResult<()> {
    if self.failed {
      return Err(format!("An earlier write to transcript '{}' failed.", self.path.display()).into());
    }
    let transcript = self.transcript.as_mut().ok_or("Transcript does not exist.")?;
    transcript.check(&record)?;
    let line = record_line(&record)?;
    let result: InfuResult<()> = async {
      let mut file = fs::OpenOptions::new().append(true).open(&self.path).await?;
      file.write_all(line.as_bytes()).await?;
      file.sync_data().await?;
      Ok(())
    }
    .await;
    if result.is_err() {
      self.failed = true;
      return result;
    }
    transcript.apply(record)
  }

  pub(super) async fn delete(self) -> InfuResult<()> {
    match fs::remove_file(&self.path).await {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(e.into()),
    }
  }
}

fn record_line(record: &TranscriptRecord) -> InfuResult<String> {
  let mut line = serde_json::to_string(record)?;
  line.push('\n');
  Ok(line)
}

#[cfg(test)]
mod tests {
  use super::*;
  use infusdk::util::uid::new_uid;
  use std::path::Path;

  struct TempDir(PathBuf);

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  struct Fixture {
    dir: TempDir,
    user_id: Uid,
    query_item_id: Uid,
  }

  impl Fixture {
    fn new() -> Self {
      let dir = TempDir(std::env::temp_dir().join(format!("infumap-transcript-test-{}", new_uid())));
      Fixture { dir, user_id: new_uid(), query_item_id: new_uid() }
    }

    fn data_dir(&self) -> &str {
      self.dir.0.to_str().unwrap()
    }

    fn path(&self) -> PathBuf {
      transcript_path(self.data_dir(), &self.user_id, &self.query_item_id).unwrap()
    }

    async fn lock(&self) -> LockedTranscript {
      try_lock_transcript(self.data_dir(), &self.user_id, &self.query_item_id).await.unwrap().unwrap()
    }

    async fn read(&self) -> Option<Transcript> {
      read_transcript(self.data_dir(), &self.user_id, &self.query_item_id).await.unwrap()
    }

    async fn create(&self) -> LockedTranscript {
      let mut locked = self.lock().await;
      let header = TranscriptHeader {
        version: TRANSCRIPT_FORMAT_VERSION,
        query_item_id: self.query_item_id.clone(),
        created_at: 1,
      };
      locked.create(header).await.unwrap();
      locked
    }
  }

  fn user(request_id: &str, text: &str) -> UserRecord {
    UserRecord {
      request_id: request_id.to_owned(),
      started_at: 10,
      text: text.to_owned(),
      settings: TurnSettings { model: None, capabilities: vec![], scope_id: None, mode: ChatRunMode::Chat },
    }
  }

  fn message(role: &str, content: &str) -> ChatHistoryMessage {
    ChatHistoryMessage {
      role: role.to_owned(),
      content: Some(content.to_owned()),
      reasoning_content: None,
      tool_call_id: None,
      tool_calls: None,
    }
  }

  fn turn(request_id: &str, outcome: TurnOutcome, messages: Vec<ChatHistoryMessage>) -> TurnRecord {
    TurnRecord {
      request_id: request_id.to_owned(),
      messages,
      rounds: vec![ActivityRound {
        number: 1,
        reasoning: "thinking".to_owned(),
        answer: "partial".to_owned(),
        tool_calls: vec![ActivityToolCall {
          call_id: "c1".to_owned(),
          name: "search".to_owned(),
          status: ActivityToolCallStatus::Complete,
          summary: Some("3 results".to_owned()),
          arguments: Some(serde_json::json!({ "query": "x" })),
          query: None,
          url: None,
          duration_ms: Some(12),
          result_preview: None,
        }],
        complete: outcome == TurnOutcome::Completed,
      }],
      started_at: 10,
      ended_at: 20,
      outcome,
      error: if outcome == TurnOutcome::Error { Some("backend failed".to_owned()) } else { None },
    }
  }

  fn history_json(transcript: &Transcript) -> Value {
    serde_json::to_value(transcript.history()).unwrap()
  }

  async fn file_len(path: &Path) -> u64 {
    fs::metadata(path).await.unwrap().len()
  }

  #[tokio::test]
  async fn round_trip() {
    let f = Fixture::new();
    assert!(f.read().await.is_none());
    let mut locked = f.create().await;
    locked.append_user(user("r1", "first")).await.unwrap();
    locked.append_turn(turn("r1", TurnOutcome::Completed, vec![message("assistant", "answer one")])).await.unwrap();
    locked.append_user(user("r2", "second")).await.unwrap();
    locked.append_turn(turn("r2", TurnOutcome::Error, vec![])).await.unwrap();
    drop(locked);

    let transcript = f.read().await.unwrap();
    assert_eq!(transcript.header.query_item_id, f.query_item_id);
    assert_eq!(transcript.revision(), 2);
    assert_eq!(transcript.turns[1].user.text, "second");
    assert_eq!(transcript.turn_status(0, false), TurnStatus::Completed);
    assert_eq!(transcript.turn_status(1, false), TurnStatus::Error);
    let end = transcript.turns[1].end.as_ref().unwrap();
    assert_eq!(end.error.as_deref(), Some("backend failed"));
    assert_eq!(end.rounds[0].tool_calls[0].duration_ms, Some(12));
    assert_eq!(end.rounds[0].tool_calls[0].status, ActivityToolCallStatus::Complete);
  }

  #[tokio::test]
  async fn history_skips_unsuccessful_turns() {
    let f = Fixture::new();
    let mut locked = f.create().await;
    locked.append_user(user("r1", "first")).await.unwrap();
    locked
      .append_turn(turn(
        "r1",
        TurnOutcome::Completed,
        vec![message("assistant", "calling"), message("tool", "result"), message("assistant", "answer one")],
      ))
      .await
      .unwrap();
    locked.append_user(user("r2", "cancelled question")).await.unwrap();
    locked.append_turn(turn("r2", TurnOutcome::Cancelled, vec![])).await.unwrap();
    locked.append_user(user("r3", "third")).await.unwrap();
    locked.append_turn(turn("r3", TurnOutcome::Completed, vec![message("assistant", "answer three")])).await.unwrap();
    drop(locked);

    let transcript = f.read().await.unwrap();
    assert_eq!(transcript.revision(), 3);
    assert_eq!(transcript.turn_status(1, false), TurnStatus::Cancelled);
    assert_eq!(
      history_json(&transcript),
      serde_json::json!([
        { "role": "user", "content": "first" },
        { "role": "assistant", "content": "calling" },
        { "role": "tool", "content": "result" },
        { "role": "assistant", "content": "answer one" },
        { "role": "user", "content": "third" },
        { "role": "assistant", "content": "answer three" },
      ])
    );
  }

  #[tokio::test]
  async fn incomplete_last_line_is_ignored_then_truncated() {
    let f = Fixture::new();
    let mut locked = f.create().await;
    locked.append_user(user("r1", "first")).await.unwrap();
    drop(locked);
    let complete = file_len(&f.path()).await;
    {
      let mut file = fs::OpenOptions::new().append(true).open(f.path()).await.unwrap();
      file.write_all(b"{\"type\":\"turn\",\"requestId\":\"r1\",\"mess").await.unwrap();
    }

    let transcript = f.read().await.unwrap();
    assert_eq!(transcript.revision(), 1);
    assert!(transcript.turns[0].end.is_none());

    let mut locked = f.lock().await;
    assert_eq!(file_len(&f.path()).await, complete);
    locked.append_turn(turn("r1", TurnOutcome::Completed, vec![message("assistant", "answer")])).await.unwrap();
    drop(locked);
    let transcript = f.read().await.unwrap();
    assert_eq!(transcript.turn_status(0, false), TurnStatus::Completed);
  }

  #[tokio::test]
  async fn malformed_record_before_last_line_is_an_error() {
    let f = Fixture::new();
    let mut locked = f.create().await;
    locked.append_user(user("r1", "first")).await.unwrap();
    drop(locked);
    {
      let mut file = fs::OpenOptions::new().append(true).open(f.path()).await.unwrap();
      file.write_all(b"not json\n").await.unwrap();
    }
    assert!(read_transcript(f.data_dir(), &f.user_id, &f.query_item_id).await.is_err());
    assert!(try_lock_transcript(f.data_dir(), &f.user_id, &f.query_item_id).await.is_err());
  }

  #[tokio::test]
  async fn turn_without_end_is_running_or_interrupted() {
    let f = Fixture::new();
    let mut locked = f.create().await;
    locked.append_user(user("r1", "first")).await.unwrap();
    assert!(chat_is_locked(&f.user_id, &f.query_item_id));
    assert_eq!(locked.transcript().unwrap().turn_status(0, true), TurnStatus::Running);
    drop(locked);
    assert!(!chat_is_locked(&f.user_id, &f.query_item_id));

    let mut locked = f.lock().await;
    assert_eq!(locked.transcript().unwrap().turn_status(0, false), TurnStatus::Interrupted);
    locked.append_user(user("r2", "second")).await.unwrap();
    locked.append_turn(turn("r2", TurnOutcome::Completed, vec![message("assistant", "answer two")])).await.unwrap();
    drop(locked);

    let transcript = f.read().await.unwrap();
    assert_eq!(transcript.turn_status(0, true), TurnStatus::Interrupted);
    assert_eq!(transcript.revision(), 2);
    assert_eq!(
      history_json(&transcript),
      serde_json::json!([{ "role": "user", "content": "second" }, { "role": "assistant", "content": "answer two" }])
    );
  }

  #[tokio::test]
  async fn second_lock_is_rejected() {
    let f = Fixture::new();
    let locked = f.lock().await;
    assert!(try_lock_transcript(f.data_dir(), &f.user_id, &f.query_item_id).await.unwrap().is_none());
    let other = new_uid();
    assert!(try_lock_transcript(f.data_dir(), &f.user_id, &other).await.unwrap().is_some());
    drop(locked);
    assert!(try_lock_transcript(f.data_dir(), &f.user_id, &f.query_item_id).await.unwrap().is_some());
  }

  #[tokio::test]
  async fn turn_must_end_the_last_turn() {
    let f = Fixture::new();
    let mut locked = f.create().await;
    assert!(locked.append_turn(turn("r1", TurnOutcome::Completed, vec![])).await.is_err());
    locked.append_user(user("r1", "first")).await.unwrap();
    let len = file_len(&f.path()).await;
    assert!(locked.append_turn(turn("other", TurnOutcome::Completed, vec![])).await.is_err());
    assert_eq!(file_len(&f.path()).await, len);
    locked.append_turn(turn("r1", TurnOutcome::Completed, vec![])).await.unwrap();
    assert!(locked.append_turn(turn("r1", TurnOutcome::Completed, vec![])).await.is_err());
    drop(locked);
    assert_eq!(f.read().await.unwrap().revision(), 1);
  }

  #[tokio::test]
  async fn create_and_delete() {
    let f = Fixture::new();
    let mut locked = f.lock().await;
    assert!(locked.append_user(user("r1", "first")).await.is_err());
    drop(locked);
    let mut locked = f.create().await;
    let header =
      TranscriptHeader { version: TRANSCRIPT_FORMAT_VERSION, query_item_id: f.query_item_id.clone(), created_at: 2 };
    assert!(locked.create(header).await.is_err());
    locked.delete().await.unwrap();
    assert!(f.read().await.is_none());
    f.lock().await.delete().await.unwrap();
  }

  #[test]
  fn path_requires_uids() {
    let user_id = new_uid();
    assert!(transcript_path("/data", &user_id, &"../escape".to_owned()).is_err());
    assert!(transcript_path("/data", &"x".to_owned(), &new_uid()).is_err());
    let path = transcript_path("/data", &user_id, &user_id).unwrap();
    assert_eq!(path, PathBuf::from(format!("/data/user_{}/chats/{}.chat", user_id, user_id)));
  }
}

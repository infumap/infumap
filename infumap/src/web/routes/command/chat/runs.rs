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

//! Live workers own their transcript lock independently of their HTTP subscribers. State updates and bounded
//! publication share one lock, so a later snapshot subscription can use the same ordering as live events.

use std::collections::{HashMap, hash_map::Entry};
use std::future::Future as _;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures_util::Stream;
use hyper::body::Frame;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::Uid;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{Notify, mpsc};
use tokio::time::{Instant, Sleep, sleep, sleep_until};

use super::activity::{ActivityPhase, ActivitySnapshot, ChatActivity};
use super::markdown::chat_response_items_json;
use super::transcript::{ActivityRound, ContextTokenCount, Transcript, TurnOutcome};
use super::{ChatStreamEventKind, cancel_pending_tool_approvals, chat_stream_event_bytes, pending_tool_approval_ids};

const SUBSCRIBER_QUEUE_CAPACITY: usize = 64;
const DETACH_GRACE: Duration = Duration::from_secs(5 * 60);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

type StreamFrame = Result<Frame<Bytes>, hyper::Error>;

#[derive(Clone, Eq, Hash, PartialEq)]
struct RunKey {
  user_id: Uid,
  query_item_id: Uid,
  request_id: String,
}

fn registry() -> &'static Mutex<HashMap<RunKey, Arc<ChatRun>>> {
  static RUNS: OnceLock<Mutex<HashMap<RunKey, Arc<ChatRun>>>> = OnceLock::new();
  RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Copy)]
pub(super) enum RunCancellation {
  Requested,
  Detached,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunSnapshot {
  revision: usize,
  started_at: i64,
  ended_at: Option<i64>,
  #[serde(flatten)]
  activity: ActivitySnapshot,
  /// These call IDs, rather than historical activity statuses, determine which approval controls are active.
  pending_approvals: Vec<String>,
  cancellation_requested: bool,
  error_message: Option<String>,
  result: Option<RunResult>,
}

#[derive(Serialize)]
struct RunResult {
  text: String,
  items: Value,
}

impl RunSnapshot {
  pub(super) fn recorded(owner_id: &Uid, transcript: &Transcript, index: usize) -> InfuResult<Self> {
    let turn = &transcript.turns[index];
    let end = turn.end.as_ref();
    let (phase, status_text) = match end.map(|end| end.outcome) {
      Some(TurnOutcome::Completed) => (ActivityPhase::Complete, "Chat complete"),
      Some(TurnOutcome::Cancelled) => (ActivityPhase::Cancelled, "Chat cancelled"),
      Some(TurnOutcome::Error) => (ActivityPhase::Error, "Chat failed"),
      None => (ActivityPhase::Interrupted, "Chat interrupted"),
    };
    let result = if let Some(end) = end.filter(|end| end.outcome == TurnOutcome::Completed) {
      let text = end
        .messages
        .last()
        .filter(|message| message.role == "assistant")
        .and_then(|message| message.content.clone())
        .ok_or("The saved chat response has no assistant text.")?;
      let items =
        chat_response_items_json(owner_id, &text).get("items").cloned().unwrap_or_else(|| Value::Array(vec![]));
      Some(RunResult { text, items })
    } else {
      None
    };
    let answer_preview = result
      .as_ref()
      .map(|result| result.text.clone())
      .unwrap_or_else(|| end.and_then(|end| end.rounds.last()).map(|round| round.answer.clone()).unwrap_or_default());
    Ok(Self {
      revision: index + 1,
      started_at: turn.user.started_at,
      ended_at: end.map(|end| end.ended_at),
      activity: ActivitySnapshot {
        phase,
        status_text: status_text.to_owned(),
        rounds: end.map(|end| end.rounds.clone()).unwrap_or_default(),
        answer_preview,
        context_tokens: end.and_then(|end| end.context_tokens),
      },
      pending_approvals: vec![],
      cancellation_requested: false,
      error_message: end
        .and_then(|end| end.error.clone())
        .or_else(|| end.is_none().then(|| "The server stopped before this response finished.".to_owned())),
      result,
    })
  }
}

pub(super) struct RunState {
  activity: ChatActivity,
  revision: usize,
  started_at: i64,
  finished: bool,
  subscribers: HashMap<u64, mpsc::Sender<StreamFrame>>,
  next_subscriber_id: u64,
  detached_since: Option<Instant>,
  cancellation: Option<RunCancellation>,
  changed: Arc<Notify>,
}

impl RunState {
  pub(super) fn new(revision: usize, started_at: i64) -> Self {
    Self {
      activity: ChatActivity::default(),
      revision,
      started_at,
      finished: false,
      subscribers: HashMap::new(),
      next_subscriber_id: 0,
      detached_since: Some(Instant::now()),
      cancellation: None,
      changed: Arc::new(Notify::new()),
    }
  }

  pub(super) fn apply(&mut self, event: &ChatStreamEventKind) {
    self.activity.apply(event);
  }

  pub(super) fn finished_rounds(&self) -> Vec<ActivityRound> {
    self.activity.finished_rounds()
  }

  pub(super) fn context_tokens(&self) -> Option<ContextTokenCount> {
    self.activity.context_tokens()
  }

  pub(super) fn send(&mut self, request_id: &str, event: ChatStreamEventKind) {
    if self.finished {
      return;
    }
    let terminal = matches!(
      event,
      ChatStreamEventKind::FinalItems { .. } | ChatStreamEventKind::Cancelled | ChatStreamEventKind::Error { .. }
    );
    self.apply(&event);
    if !self.subscribers.is_empty() {
      let data = chat_stream_event_bytes(request_id, event);
      // A stalled connection must not pause tools or inference. Closing its sender makes it recover from a
      // fresh snapshot after its buffered frames drain, instead of silently skipping output on an open stream.
      self.subscribers.retain(|_, subscriber| subscriber.try_send(Ok(Frame::data(data.clone()))).is_ok());
      if self.subscribers.is_empty() {
        self.detached_since = Some(Instant::now());
        self.changed.notify_waiters();
      }
    }
    if terminal {
      self.finish();
    }
  }

  fn finish(&mut self) {
    self.finished = true;
    self.subscribers.clear();
    self.changed.notify_waiters();
  }
}

pub(super) struct ChatRun {
  key: RunKey,
  state: Arc<Mutex<RunState>>,
}

impl ChatRun {
  pub(super) fn is_finished(&self) -> bool {
    self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).finished
  }

  pub(super) fn subscribe(self: &Arc<Self>) -> Option<RunSubscriber> {
    let (tx, rx) = mpsc::channel(SUBSCRIBER_QUEUE_CAPACITY);
    let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.finished {
      return None;
    }
    let activity = state.activity.snapshot();
    let pending = pending_tool_approval_ids(&self.key.request_id, &self.key.user_id);
    let pending_approvals = activity
      .rounds
      .iter()
      .flat_map(|round| &round.tool_calls)
      .filter(|call| pending.contains(&call.call_id))
      .map(|call| call.call_id.clone())
      .collect();
    let snapshot = RunSnapshot {
      revision: state.revision,
      started_at: state.started_at,
      ended_at: None,
      activity,
      pending_approvals,
      cancellation_requested: state.cancellation.is_some(),
      error_message: None,
      result: None,
    };
    // Capture state and subscribe under the publication lock. The initial frame is separate from the queue,
    // so events produced while HTTP starts are delivered strictly after the snapshot, without a replay log.
    let initial = chat_stream_event_bytes(&self.key.request_id, ChatStreamEventKind::Snapshot { snapshot });
    let id = state.next_subscriber_id;
    state.next_subscriber_id += 1;
    state.subscribers.insert(id, tx);
    state.detached_since = None;
    state.changed.notify_waiters();
    Some(RunSubscriber {
      run: Arc::downgrade(self),
      id,
      rx,
      initial: Some(initial),
      heartbeat: Box::pin(sleep(HEARTBEAT_INTERVAL)),
    })
  }

  pub(super) fn cancel(&self) {
    let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !state.finished {
      state.cancellation.get_or_insert(RunCancellation::Requested);
      state.changed.notify_waiters();
    }
  }

  pub(super) async fn finished(&self) {
    let changed = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).changed.clone();
    loop {
      let notified = changed.notified();
      tokio::pin!(notified);
      notified.as_mut().enable();
      if self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).finished {
        return;
      }
      notified.await;
    }
  }

  pub(super) async fn cancelled(&self) -> RunCancellation {
    let changed = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).changed.clone();
    loop {
      let notified = changed.notified();
      tokio::pin!(notified);
      notified.as_mut().enable();
      let deadline = {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(reason) = state.cancellation {
          return reason;
        }
        state.detached_since.map(|since| since + DETACH_GRACE)
      };
      match deadline {
        Some(deadline) => {
          tokio::select! {
            _ = notified => {},
            _ = sleep_until(deadline) => {
              let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
              // Reattachment may have reset the deadline while the timer was waking.
              if state.detached_since.is_some_and(|since| since + DETACH_GRACE <= Instant::now()) {
                return *state.cancellation.get_or_insert(RunCancellation::Detached);
              }
            }
          }
        }
        None => notified.await,
      }
    }
  }
}

pub(super) struct RunSubscriber {
  run: Weak<ChatRun>,
  id: u64,
  rx: mpsc::Receiver<StreamFrame>,
  initial: Option<Bytes>,
  heartbeat: Pin<Box<Sleep>>,
}

impl Stream for RunSubscriber {
  type Item = StreamFrame;

  fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
    if let Some(initial) = self.initial.take() {
      self.heartbeat.as_mut().reset(Instant::now() + HEARTBEAT_INTERVAL);
      return Poll::Ready(Some(Ok(Frame::data(initial))));
    }
    match self.rx.poll_recv(cx) {
      Poll::Ready(frame) => {
        self.heartbeat.as_mut().reset(Instant::now() + HEARTBEAT_INTERVAL);
        return Poll::Ready(frame);
      }
      Poll::Pending => {}
    }
    if self.heartbeat.as_mut().poll(cx).is_ready() {
      self.heartbeat.as_mut().reset(Instant::now() + HEARTBEAT_INTERVAL);
      // Blank NDJSON lines are transport heartbeats: they carry no application state and existing readers skip them.
      return Poll::Ready(Some(Ok(Frame::data(Bytes::from_static(b"\n")))));
    }
    Poll::Pending
  }
}

impl Drop for RunSubscriber {
  fn drop(&mut self) {
    if let Some(run) = self.run.upgrade() {
      let mut state = run.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
      if state.subscribers.remove(&self.id).is_some() && state.subscribers.is_empty() {
        state.detached_since = Some(Instant::now());
        state.changed.notify_waiters();
      }
    }
  }
}

/// Owned by the worker future, including before its first poll, so dropping or unwinding that future cannot
/// leave a run registered or approvals waiting after its transcript lock has been released.
pub(super) struct RunRegistration {
  pub(super) run: Arc<ChatRun>,
}

impl Drop for RunRegistration {
  fn drop(&mut self) {
    cancel_pending_tool_approvals(&self.run.key.request_id, &self.run.key.user_id);
    let mut runs = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if runs.get(&self.run.key).is_some_and(|run| Arc::ptr_eq(run, &self.run)) {
      runs.remove(&self.run.key);
    }
    drop(runs);
    self.run.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).finish();
  }
}

pub(super) fn register(
  user_id: Uid,
  query_item_id: Uid,
  request_id: String,
  state: Arc<Mutex<RunState>>,
) -> Result<(RunRegistration, RunSubscriber), &'static str> {
  let key = RunKey { user_id, query_item_id, request_id };
  let run = Arc::new(ChatRun { key: key.clone(), state });
  let mut runs = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  match runs.entry(key) {
    Entry::Occupied(_) => Err("A response is already registered for this chat request."),
    Entry::Vacant(entry) => {
      let subscriber = run.subscribe().ok_or("The chat request already ended.")?;
      entry.insert(run.clone());
      Ok((RunRegistration { run }, subscriber))
    }
  }
}

/// Callers authenticate and check current chat access before looking up this user-scoped identity.
pub(super) fn find(user_id: &Uid, query_item_id: &Uid, request_id: &str) -> Option<Arc<ChatRun>> {
  let key =
    RunKey { user_id: user_id.clone(), query_item_id: query_item_id.clone(), request_id: request_id.to_owned() };
  registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&key).cloned()
}

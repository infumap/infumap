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
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures_util::Stream;
use hyper::body::Frame;
use infusdk::util::uid::Uid;
use tokio::sync::{Notify, mpsc};
use tokio::time::{Instant, sleep_until};

use super::activity::ChatActivity;
use super::transcript::{ActivityRound, ContextTokenCount};
use super::{ChatStreamEventKind, cancel_pending_tool_approvals, chat_stream_event_bytes};

const SUBSCRIBER_QUEUE_CAPACITY: usize = 64;
const DETACH_GRACE: Duration = Duration::from_secs(5 * 60);

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

pub(super) struct RunState {
  activity: ChatActivity,
  subscribers: HashMap<u64, mpsc::Sender<StreamFrame>>,
  next_subscriber_id: u64,
  detached_since: Option<Instant>,
  cancellation: Option<RunCancellation>,
  changed: Arc<Notify>,
}

impl Default for RunState {
  fn default() -> Self {
    Self {
      activity: ChatActivity::default(),
      subscribers: HashMap::new(),
      next_subscriber_id: 0,
      detached_since: Some(Instant::now()),
      cancellation: None,
      changed: Arc::new(Notify::new()),
    }
  }
}

impl RunState {
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
    self.apply(&event);
    if self.subscribers.is_empty() {
      return;
    }
    let data = chat_stream_event_bytes(request_id, event);
    // Waiting for capacity here would let one stalled HTTP connection pause tools and inference. Removing its
    // only sender closes that stream after its buffered frames drain; recovery obtains fresh state.
    self.subscribers.retain(|_, subscriber| subscriber.try_send(Ok(Frame::data(data.clone()))).is_ok());
    if self.subscribers.is_empty() {
      self.detached_since = Some(Instant::now());
      self.changed.notify_one();
    }
  }
}

pub(super) struct ChatRun {
  key: RunKey,
  state: Arc<Mutex<RunState>>,
}

impl ChatRun {
  fn subscribe(self: &Arc<Self>) -> RunSubscriber {
    let (tx, rx) = mpsc::channel(SUBSCRIBER_QUEUE_CAPACITY);
    let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let id = state.next_subscriber_id;
    state.next_subscriber_id += 1;
    state.subscribers.insert(id, tx);
    state.detached_since = None;
    state.changed.notify_one();
    RunSubscriber { run: Arc::downgrade(self), id, rx }
  }

  // The explicit cancellation route will call this when it is added; disconnects use the grace deadline below.
  #[allow(dead_code)]
  pub(super) fn cancel(&self) {
    let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.cancellation.get_or_insert(RunCancellation::Requested);
    state.changed.notify_one();
  }

  pub(super) async fn cancelled(&self) -> RunCancellation {
    let changed = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).changed.clone();
    loop {
      let notified = changed.notified();
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
}

impl Stream for RunSubscriber {
  type Item = StreamFrame;

  fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
    self.rx.poll_recv(cx)
  }
}

impl Drop for RunSubscriber {
  fn drop(&mut self) {
    if let Some(run) = self.run.upgrade() {
      let mut state = run.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
      if state.subscribers.remove(&self.id).is_some() && state.subscribers.is_empty() {
        state.detached_since = Some(Instant::now());
        state.changed.notify_one();
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
    cancel_pending_tool_approvals(&self.run.key.request_id);
    let mut runs = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if runs.get(&self.run.key).is_some_and(|run| Arc::ptr_eq(run, &self.run)) {
      runs.remove(&self.run.key);
    }
    drop(runs);
    self.run.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).subscribers.clear();
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
      let subscriber = run.subscribe();
      entry.insert(run.clone());
      Ok((RunRegistration { run }, subscriber))
    }
  }
}

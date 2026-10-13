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

//! Collects a live chat turn's activity (model rounds and tool calls) from the stream events it sends, so the
//! transcript records what the turn dropdown showed. This mirrors `reduceQueryChatStreamEvent` in the client's
//! chat.ts; keep the two in step.

use serde_json::Value;

use super::ChatStreamEventKind;
use super::transcript::{ActivityRound, ActivityToolCall, ActivityToolCallStatus, ContextTokenCount};

#[derive(Default)]
pub(super) struct ChatActivity {
  rounds: Vec<ActivityRound>,
  context_tokens: Option<ContextTokenCount>,
}

impl ChatActivity {
  pub(super) fn apply(&mut self, event: &ChatStreamEventKind) {
    match event {
      ChatStreamEventKind::ContextTokens { tokens, exact } => {
        self.context_tokens = Some(ContextTokenCount { tokens: *tokens, exact: *exact });
      }
      ChatStreamEventKind::ModelRoundStarted { round } => {
        self.complete_rounds();
        self.round(*round).complete = false;
      }
      ChatStreamEventKind::ReasoningDelta { round, text } => self.round(*round).reasoning.push_str(text),
      ChatStreamEventKind::AnswerDelta { round, text } => self.round(*round).answer.push_str(text),
      ChatStreamEventKind::ToolApprovalRequired { round, call_id, name, query, url, arguments } => {
        let round = self.round(*round);
        round.complete = true;
        round.tool_calls.retain(|tool_call| tool_call.call_id != *call_id);
        round.tool_calls.push(ActivityToolCall {
          call_id: call_id.clone(),
          name: name.clone(),
          status: ActivityToolCallStatus::AwaitingApproval,
          summary: None,
          arguments: non_null(arguments),
          query: query.clone(),
          url: url.clone(),
          duration_ms: None,
          result_preview: None,
        });
      }
      ChatStreamEventKind::ToolCallStarted { round, call_id, name, arguments } => {
        let round = self.round(*round);
        round.complete = true;
        let existing_index = round.tool_calls.iter().position(|tool_call| tool_call.call_id == *call_id);
        let existing = existing_index.map(|index| round.tool_calls.remove(index));
        round.tool_calls.push(ActivityToolCall {
          call_id: call_id.clone(),
          name: name.clone(),
          status: ActivityToolCallStatus::Running,
          summary: None,
          arguments: non_null(arguments).or_else(|| existing.as_ref().and_then(|e| e.arguments.clone())),
          query: existing.as_ref().and_then(|e| e.query.clone()),
          url: existing.as_ref().and_then(|e| e.url.clone()),
          duration_ms: None,
          result_preview: None,
        });
      }
      ChatStreamEventKind::ToolCallFinished { round, call_id, name, summary, duration_ms, result_preview } => {
        let round = self.round(*round);
        round.complete = true;
        let existing_index = round.tool_calls.iter().position(|tool_call| tool_call.call_id == *call_id);
        let existing = existing_index.map(|index| &round.tool_calls[index]);
        let completed = ActivityToolCall {
          call_id: call_id.clone(),
          name: name.clone(),
          status: ActivityToolCallStatus::Complete,
          summary: Some(summary.clone()),
          arguments: existing.and_then(|e| e.arguments.clone()),
          query: existing.and_then(|e| e.query.clone()),
          url: existing.and_then(|e| e.url.clone()),
          duration_ms: Some(*duration_ms),
          result_preview: non_null(result_preview),
        };
        match existing_index {
          Some(index) => round.tool_calls[index] = completed,
          None => round.tool_calls.push(completed),
        }
      }
      _ => {}
    }
  }

  /// The rounds as the client has them once the turn ends, however it ended: every round complete. A tool call
  /// that was running or awaiting approval keeps that status.
  pub(super) fn finished_rounds(&self) -> Vec<ActivityRound> {
    self.rounds.iter().cloned().map(|round| ActivityRound { complete: true, ..round }).collect()
  }

  pub(super) fn context_tokens(&self) -> Option<ContextTokenCount> {
    self.context_tokens
  }

  fn complete_rounds(&mut self) {
    for round in &mut self.rounds {
      round.complete = true;
    }
  }

  fn round(&mut self, number: usize) -> &mut ActivityRound {
    let index = match self.rounds.iter().position(|round| round.number == number) {
      Some(index) => index,
      None => {
        self.rounds.push(ActivityRound {
          number,
          reasoning: String::new(),
          answer: String::new(),
          tool_calls: vec![],
          complete: false,
        });
        self.rounds.len() - 1
      }
    };
    &mut self.rounds[index]
  }
}

fn non_null(value: &Value) -> Option<Value> {
  (!value.is_null()).then(|| value.clone())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn apply_all(events: Vec<ChatStreamEventKind>) -> ChatActivity {
    let mut activity = ChatActivity::default();
    for event in &events {
      activity.apply(event);
    }
    activity
  }

  #[test]
  fn collects_rounds_text_and_tool_calls() {
    let activity = apply_all(vec![
      ChatStreamEventKind::status("Preparing request"),
      ChatStreamEventKind::ModelRoundStarted { round: 1 },
      ChatStreamEventKind::ReasoningDelta { round: 1, text: "think ".to_owned() },
      ChatStreamEventKind::ReasoningDelta { round: 1, text: "more".to_owned() },
      ChatStreamEventKind::tool_approval_required(
        1,
        "c1",
        "web_search",
        Some("rust".to_owned()),
        None,
        json!({ "query": "rust" }),
      ),
      ChatStreamEventKind::tool_call_started(1, "c1", "web_search", Value::Null),
      ChatStreamEventKind::tool_call_finished(1, "c1", "web_search", "3 results", 42, json!({ "n": 3 })),
      ChatStreamEventKind::tool_call_finished(1, "c2", "search", "nothing", 5, Value::Null),
      ChatStreamEventKind::ModelRoundStarted { round: 2 },
      ChatStreamEventKind::AnswerDelta { round: 2, text: "The ".to_owned() },
      ChatStreamEventKind::AnswerDelta { round: 2, text: "answer".to_owned() },
      ChatStreamEventKind::context_tokens(100, true),
    ]);

    assert_eq!(activity.rounds.len(), 2);
    let first = &activity.rounds[0];
    assert_eq!(first.reasoning, "think more");
    assert!(first.complete);
    assert_eq!(first.tool_calls.len(), 2);
    let web = &first.tool_calls[0];
    assert_eq!(web.status, ActivityToolCallStatus::Complete);
    assert_eq!(web.summary.as_deref(), Some("3 results"));
    assert_eq!(web.arguments, Some(json!({ "query": "rust" })));
    assert_eq!(web.query.as_deref(), Some("rust"));
    assert_eq!(web.duration_ms, Some(42));
    assert_eq!(web.result_preview, Some(json!({ "n": 3 })));
    assert_eq!(first.tool_calls[1].call_id, "c2");
    assert_eq!(first.tool_calls[1].result_preview, None);

    let second = &activity.rounds[1];
    assert_eq!(second.answer, "The answer");
    assert!(!second.complete);
    assert!(activity.finished_rounds().iter().all(|round| round.complete));
    assert_eq!(activity.context_tokens(), Some(ContextTokenCount { tokens: 100, exact: true }));
  }

  #[test]
  fn interrupted_tool_calls_keep_their_status() {
    let activity = apply_all(vec![
      ChatStreamEventKind::ModelRoundStarted { round: 1 },
      ChatStreamEventKind::tool_approval_required(1, "c1", "fetch_page", None, Some("https://x".to_owned()), json!({})),
      ChatStreamEventKind::ModelRoundStarted { round: 2 },
      ChatStreamEventKind::tool_call_started(2, "c2", "search", json!({ "text": "q" })),
    ]);
    let rounds = activity.finished_rounds();
    assert_eq!(rounds[0].tool_calls[0].status, ActivityToolCallStatus::AwaitingApproval);
    assert_eq!(rounds[0].tool_calls[0].url.as_deref(), Some("https://x"));
    assert_eq!(rounds[1].tool_calls[0].status, ActivityToolCallStatus::Running);
    assert_eq!(rounds[1].tool_calls[0].arguments, Some(json!({ "text": "q" })));
  }
}

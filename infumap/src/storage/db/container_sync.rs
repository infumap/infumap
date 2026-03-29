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

use infusdk::util::uid::Uid;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};

const RECENT_DELTA_LIMIT_PER_CONTAINER: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContainerSyncVersion {
  pub id: Uid,
  pub version: u64,
}

#[derive(Clone, Default)]
pub struct ContainerSyncDelta {
  child_upserts: HashMap<Uid, Map<String, Value>>,
  child_deletes: HashSet<Uid>,
  attachment_snapshots: HashMap<Uid, Vec<Map<String, Value>>>,
}

impl ContainerSyncDelta {
  pub fn is_empty(&self) -> bool {
    self.child_upserts.is_empty() && self.child_deletes.is_empty() && self.attachment_snapshots.is_empty()
  }

  pub fn add_child_upsert(&mut self, item_json: Map<String, Value>) {
    if let Some(id) = json_item_id(&item_json) {
      self.child_deletes.remove(&id);
      self.child_upserts.insert(id, item_json);
    }
  }

  pub fn add_child_delete(&mut self, child_id: &Uid) {
    self.child_upserts.remove(child_id);
    self.child_deletes.insert(child_id.clone());
    self.attachment_snapshots.remove(child_id);
  }

  pub fn set_attachment_snapshot(&mut self, parent_id: &Uid, attachment_json: Vec<Map<String, Value>>) {
    self.attachment_snapshots.insert(parent_id.clone(), attachment_json);
  }

  pub fn merge(&mut self, other: &ContainerSyncDelta) {
    for (child_id, item_json) in &other.child_upserts {
      self.child_deletes.remove(child_id);
      self.child_upserts.insert(child_id.clone(), item_json.clone());
    }

    for child_id in &other.child_deletes {
      self.child_upserts.remove(child_id);
      self.child_deletes.insert(child_id.clone());
      self.attachment_snapshots.remove(child_id);
    }

    for (parent_id, attachment_json) in &other.attachment_snapshots {
      self.attachment_snapshots.insert(parent_id.clone(), attachment_json.clone());
    }
  }

  pub fn child_upserts(&self) -> Vec<Map<String, Value>> {
    let mut child_ids = self.child_upserts.keys().cloned().collect::<Vec<_>>();
    child_ids.sort();
    child_ids.into_iter().filter_map(|child_id| self.child_upserts.get(&child_id).cloned()).collect::<Vec<_>>()
  }

  pub fn child_deletes(&self) -> Vec<Uid> {
    let mut child_ids = self.child_deletes.iter().cloned().collect::<Vec<_>>();
    child_ids.sort();
    child_ids
  }

  pub fn attachment_snapshots_json(&self) -> Map<String, Value> {
    let mut parent_ids = self.attachment_snapshots.keys().cloned().collect::<Vec<_>>();
    parent_ids.sort();

    let mut result = Map::new();
    for parent_id in parent_ids {
      let attachment_json = self
        .attachment_snapshots
        .get(&parent_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(Value::from)
        .collect::<Vec<_>>();
      result.insert(parent_id, Value::Array(attachment_json));
    }
    result
  }
}

pub enum ContainerSyncLookup {
  UpToDate,
  Delta { version: u64, delta: ContainerSyncDelta },
  Snapshot { version: u64 },
}

#[derive(Default)]
struct UserContainerSyncState {
  version_by_container: HashMap<Uid, u64>,
  recent_entries_by_container: HashMap<Uid, VecDeque<ContainerSyncLogEntry>>,
}

struct ContainerSyncLogEntry {
  version: u64,
  kind: ContainerSyncLogEntryKind,
}

enum ContainerSyncLogEntryKind {
  Delta(ContainerSyncDelta),
  SnapshotRequired,
}

pub struct ContainerSyncState {
  by_user_id: HashMap<Uid, UserContainerSyncState>,
}

impl ContainerSyncState {
  pub fn new() -> Self {
    Self { by_user_id: HashMap::new() }
  }

  pub fn version_for_container(&self, user_id: &Uid, container_id: &Uid) -> u64 {
    self
      .by_user_id
      .get(user_id)
      .and_then(|user_state| user_state.version_by_container.get(container_id))
      .copied()
      .unwrap_or(0)
  }

  pub fn versions_for_containers<I>(&self, user_id: &Uid, container_ids: I) -> Vec<ContainerSyncVersion>
  where
    I: IntoIterator<Item = Uid>,
  {
    let mut versions = container_ids
      .into_iter()
      .map(|container_id| ContainerSyncVersion {
        version: self.version_for_container(user_id, &container_id),
        id: container_id,
      })
      .collect::<Vec<_>>();
    versions.sort_by(|a, b| a.id.cmp(&b.id));
    versions
  }

  pub fn record_delta(&mut self, user_id: &Uid, container_id: &Uid, delta: ContainerSyncDelta) -> u64 {
    if delta.is_empty() {
      return self.version_for_container(user_id, container_id);
    }

    let version = self.next_version(user_id, container_id);
    self.append_entry(
      user_id,
      container_id,
      ContainerSyncLogEntry { version, kind: ContainerSyncLogEntryKind::Delta(delta) },
    );
    version
  }

  pub fn record_snapshot_required(&mut self, user_id: &Uid, container_id: &Uid) -> u64 {
    let version = self.next_version(user_id, container_id);
    self.append_entry(
      user_id,
      container_id,
      ContainerSyncLogEntry { version, kind: ContainerSyncLogEntryKind::SnapshotRequired },
    );
    version
  }

  pub fn sync_lookup(&self, user_id: &Uid, container_id: &Uid, known_version: Option<u64>) -> ContainerSyncLookup {
    let current_version = self.version_for_container(user_id, container_id);

    if known_version == Some(current_version) {
      return ContainerSyncLookup::UpToDate;
    }

    let Some(known_version) = known_version else {
      return ContainerSyncLookup::Snapshot { version: current_version };
    };

    if known_version > current_version {
      return ContainerSyncLookup::Snapshot { version: current_version };
    }

    let Some(user_state) = self.by_user_id.get(user_id) else {
      return ContainerSyncLookup::Snapshot { version: current_version };
    };
    let Some(entries) = user_state.recent_entries_by_container.get(container_id) else {
      return ContainerSyncLookup::Snapshot { version: current_version };
    };

    let mut merged_delta = ContainerSyncDelta::default();
    let mut expected_version = known_version + 1;

    for entry in entries {
      if entry.version < expected_version {
        continue;
      }

      if entry.version != expected_version {
        return ContainerSyncLookup::Snapshot { version: current_version };
      }

      match &entry.kind {
        ContainerSyncLogEntryKind::Delta(delta) => merged_delta.merge(delta),
        ContainerSyncLogEntryKind::SnapshotRequired => {
          return ContainerSyncLookup::Snapshot { version: current_version };
        }
      }

      expected_version += 1;
    }

    if expected_version != current_version + 1 || merged_delta.is_empty() {
      return ContainerSyncLookup::Snapshot { version: current_version };
    }

    ContainerSyncLookup::Delta { version: current_version, delta: merged_delta }
  }

  fn next_version(&mut self, user_id: &Uid, container_id: &Uid) -> u64 {
    let user_state = self.by_user_id.entry(user_id.clone()).or_default();
    let version = user_state.version_by_container.entry(container_id.clone()).or_insert(0);
    *version += 1;
    *version
  }

  fn append_entry(&mut self, user_id: &Uid, container_id: &Uid, entry: ContainerSyncLogEntry) {
    let user_state = self.by_user_id.entry(user_id.clone()).or_default();
    let entries = user_state.recent_entries_by_container.entry(container_id.clone()).or_default();
    entries.push_back(entry);
    while entries.len() > RECENT_DELTA_LIMIT_PER_CONTAINER {
      entries.pop_front();
    }
  }
}

fn json_item_id(item_json: &Map<String, Value>) -> Option<Uid> {
  item_json.get("id").and_then(|value| value.as_str()).map(|value| value.to_owned())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn item_json(id: &str) -> Map<String, Value> {
    let mut item = Map::new();
    item.insert(String::from("id"), Value::String(id.to_owned()));
    item
  }

  #[test]
  fn returns_merged_delta_for_contiguous_versions() {
    let user_id = String::from("user");
    let container_id = String::from("container");
    let mut state = ContainerSyncState::new();

    let mut first = ContainerSyncDelta::default();
    first.add_child_upsert(item_json("child-a"));
    state.record_delta(&user_id, &container_id, first);

    let mut second = ContainerSyncDelta::default();
    second.add_child_upsert(item_json("child-b"));
    second.add_child_delete(&String::from("child-a"));
    state.record_delta(&user_id, &container_id, second);

    match state.sync_lookup(&user_id, &container_id, Some(0)) {
      ContainerSyncLookup::Delta { version, delta } => {
        assert_eq!(version, 2);
        assert_eq!(delta.child_deletes(), vec![String::from("child-a")]);
        assert_eq!(delta.child_upserts().len(), 1);
      }
      _ => panic!("expected delta response"),
    }
  }

  #[test]
  fn returns_snapshot_when_snapshot_required_was_recorded() {
    let user_id = String::from("user");
    let container_id = String::from("container");
    let mut state = ContainerSyncState::new();

    state.record_snapshot_required(&user_id, &container_id);

    match state.sync_lookup(&user_id, &container_id, Some(0)) {
      ContainerSyncLookup::Snapshot { version } => assert_eq!(version, 1),
      _ => panic!("expected snapshot response"),
    }
  }

  #[test]
  fn returns_snapshot_when_client_is_older_than_retained_delta_window() {
    let user_id = String::from("user");
    let container_id = String::from("container");
    let mut state = ContainerSyncState::new();

    for idx in 0..=RECENT_DELTA_LIMIT_PER_CONTAINER {
      let mut delta = ContainerSyncDelta::default();
      delta.add_child_upsert(item_json(&format!("child-{idx}")));
      state.record_delta(&user_id, &container_id, delta);
    }

    match state.sync_lookup(&user_id, &container_id, Some(0)) {
      ContainerSyncLookup::Snapshot { version } => assert_eq!(version, (RECENT_DELTA_LIMIT_PER_CONTAINER + 1) as u64),
      _ => panic!("expected snapshot response"),
    }
  }
}

// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Shared resource configuration for query profiles, requests and transcript turns.
//! Search/chat/deep-research mode is deliberately stored separately.

use infusdk::util::uid::Uid;
use serde::{Deserialize, Serialize};

use super::ChatRunMode;
pub use super::backend::ChatModelSelection;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryConfiguration {
  /// None covers everything in Infumap. Scope limits retrieval, not existing context or attachments.
  #[serde(deserialize_with = "Option::deserialize")]
  pub scope_id: Option<Uid>,
  /// None means no model selected. Chat execution requires a selection.
  #[serde(deserialize_with = "Option::deserialize")]
  pub model: Option<ChatModelSelection>,
  /// Capability IDs: infumap_data and configured MCP server IDs. Order has no meaning.
  pub capabilities: Vec<String>,
}

/// A named setup. Pinning, ordering and the default profile are separate user preferences.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QueryProfile {
  pub id: Uid,
  pub name: String,
  pub configuration: QueryConfiguration,
}

/// Settings captured for one chat turn; mode and profile provenance are separate from resources.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TurnSettings {
  pub(super) configuration: QueryConfiguration,
  #[serde(deserialize_with = "Option::deserialize")]
  pub(super) applied_profile: Option<QueryProfile>,
  pub(super) mode: ChatRunMode,
}

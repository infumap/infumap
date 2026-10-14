// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Shared resource configuration for query profiles, requests and transcript turns.
//! Search/chat/deep-research mode is deliberately stored separately.

use infusdk::util::uid::Uid;
use serde::{Deserialize, Serialize};

/// An explicit provider route. A null model uses the provider's model; null effort uses its default.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatModelSelection {
  pub backend: String,
  #[serde(deserialize_with = "Option::deserialize")]
  pub model: Option<String>,
  #[serde(deserialize_with = "Option::deserialize")]
  pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
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
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QueryProfile {
  pub id: Uid,
  pub name: String,
  pub configuration: QueryConfiguration,
}

/// A model/provider favorite; reasoning effort remains part of the query configuration.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryModelFavorite {
  pub backend: String,
  #[serde(deserialize_with = "Option::deserialize")]
  pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryProfilePreferences {
  pub default_profile_id: Uid,
  /// Ordered subset of profiles shown as one-click shortcuts.
  pub pinned_profile_ids: Vec<Uid>,
  pub model_favorites: Vec<QueryModelFavorite>,
}

/// One account's ordered profiles and preferences, updated atomically with optimistic concurrency.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QueryProfileCollection {
  pub revision: u64,
  pub profiles: Vec<QueryProfile>,
  pub preferences: QueryProfilePreferences,
}

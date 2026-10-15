// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Shared resource configuration for query profiles, requests and transcript turns.
//! Search/chat/deep-research mode is deliberately stored separately.
//!
//! These types are persisted in two places with different compatibility rules. Profiles are in the
//! user log: a change needs a new user log version and a migration. Transcript turns embed them in
//! `.chat` files: a change needs a new transcript format version that still reads the old ones (see
//! `TRANSCRIPT_FORMAT_VERSION`).

use infusdk::util::infu::InfuResult;
use infusdk::util::uid::{Uid, is_uid};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_CAPABILITIES: usize = 64;
pub const MAX_PROFILE_NAME_BYTES: usize = 120;

/// Non-blank, at most `max_len` bytes, and free of control characters.
pub fn validate_text(text: &str, field: &str, max_len: usize) -> InfuResult<()> {
  if text.trim().is_empty() || text.len() > max_len || text.chars().any(char::is_control) {
    return Err(format!("Invalid {field}.").into());
  }
  Ok(())
}

/// An explicit provider ID and model. Chat requires a model ID; null effort uses its default.
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
  pub tool_approval: ToolApproval,
}

/// Automatic execution still asks before external disclosure when private sources are enabled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolApproval {
  Automatic,
  AlwaysAsk,
}

/// Used only by versioned readers/migrations. Current requests and stored records require the field.
pub(crate) fn upgrade_legacy_configuration(configuration: &mut Value) -> InfuResult<()> {
  configuration
    .as_object_mut()
    .ok_or("Legacy query configuration must be an object.")?
    .entry("toolApproval")
    .or_insert_with(|| Value::String("always_ask".to_owned()));
  Ok(())
}

impl QueryConfiguration {
  /// Validates the format of every field and sorts and deduplicates capabilities. Used wherever a
  /// configuration arrives from a client: profile writes, chat requests and search.
  pub fn normalize(&mut self) -> InfuResult<()> {
    if self.scope_id.as_ref().is_some_and(|id| !is_uid(id)) {
      return Err("Invalid scope ID.".into());
    }
    if let Some(model) = &self.model {
      validate_text(&model.backend, "model provider", 256)?;
      if let Some(id) = &model.model {
        validate_text(id, "model ID", 512)?;
      }
      if let Some(effort) = &model.reasoning_effort {
        validate_text(effort, "reasoning effort", 64)?;
      }
    }
    for capability in &self.capabilities {
      validate_text(capability, "capability ID", 128)?;
    }
    self.capabilities.sort();
    self.capabilities.dedup();
    if self.capabilities.len() > MAX_CAPABILITIES {
      return Err("Too many capabilities.".into());
    }
    // Availability is deliberately not checked: a removed scope, model or tool remains repairable.
    Ok(())
  }
}

/// A named setup, also recorded in transcripts as the applied snapshot. Pinning, ordering and the
/// default profile are account preferences, so they are not part of the profile.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QueryProfile {
  pub id: Uid,
  pub name: String,
  pub configuration: QueryConfiguration,
}

impl QueryProfile {
  /// Validates the ID and configuration, and trims and validates the name.
  pub fn normalize(&mut self) -> InfuResult<()> {
    if !is_uid(&self.id) {
      return Err("Invalid profile ID.".into());
    }
    self.name = self.name.trim().to_owned();
    validate_text(&self.name, "profile name", MAX_PROFILE_NAME_BYTES)?;
    self.configuration.normalize()
  }
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
  /// Profiles shown as one-click shortcuts, kept in profile order.
  pub pinned_profile_ids: Vec<Uid>,
  pub model_favorites: Vec<QueryModelFavorite>,
}

/// One account's ordered profiles and preferences, updated atomically.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QueryProfileCollection {
  /// Incremented by every change, so clients can ignore responses older than what they hold.
  pub revision: u64,
  pub profiles: Vec<QueryProfile>,
  pub preferences: QueryProfilePreferences,
}

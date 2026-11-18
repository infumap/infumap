// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Shared resource configuration for query profiles, requests and transcript turns.
//! Search/chat/deep-research mode is deliberately stored separately.
//!
//! These types are persisted in two places with different compatibility rules. Profiles are in the
//! user log: changes requiring record conversion need a new user log version and a migration.
//! Transcript turns embed these types in `.chat` files: a required-field or semantic change needs a
//! new transcript format version that still reads the old ones. Optional fields can default when
//! absent (see `TRANSCRIPT_FORMAT_VERSION`).

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

/// What retrieval covers, as saved wherever a choice of scope is remembered.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScopeRef {
  /// The default search universe: the home page tree and query chats.
  Everything,
  /// A collection's members and their descendants.
  Collection { id: Uid },
  /// Everything minus a collection's coverage. The inversion is part of the reference, not a flag on the
  /// collection, so one collection can limit one chat and be hidden from another, and changing how one reference
  /// uses it never changes the others.
  EverythingExcept { id: Uid },
  /// What a bare scope page id saved before collections becomes. Covers nothing. It is deliberately not read as a
  /// collection with the same id: flagging an old scope page that had an Exclude container would otherwise silently
  /// widen everything still pointing at it.
  Unavailable,
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
  /// What Infumap retrieval covers. It limits retrieval, not existing context or attachments.
  pub scope: ScopeRef,
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

/// Replaces a configuration's bare `scopeId`, saved before collections, with a `scope`. A scope page id becomes
/// `unavailable`, never a collection with the same id (see `ScopeRef::Unavailable`). A configuration that already
/// has a `scope` is left alone, so this can be applied to records of any age.
pub(crate) fn upgrade_legacy_scope(configuration: &mut Value) -> InfuResult<()> {
  let configuration = configuration.as_object_mut().ok_or("Legacy query configuration must be an object.")?;
  let Some(scope_id) = configuration.remove("scopeId") else {
    return Ok(());
  };
  let scope = if scope_id.is_null() { ScopeRef::Everything } else { ScopeRef::Unavailable };
  configuration.entry("scope").or_insert(serde_json::to_value(scope)?);
  Ok(())
}

impl QueryConfiguration {
  /// Validates the format of every field and sorts and deduplicates capabilities. Used wherever a
  /// configuration arrives from a client: profile writes, chat requests and search.
  pub fn normalize(&mut self) -> InfuResult<()> {
    if let ScopeRef::Collection { id } | ScopeRef::EverythingExcept { id } = &self.scope
      && !is_uid(id)
    {
      return Err("Invalid collection ID.".into());
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
    // Availability is deliberately not checked: a removed collection, model or tool remains repairable.
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
  /// None starts new queries from the server's current catalog instead of a saved profile.
  pub default_profile_id: Option<Uid>,
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

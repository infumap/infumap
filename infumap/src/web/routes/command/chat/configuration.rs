// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

use super::ChatRunMode;
pub use crate::query_configuration::{QueryConfiguration, QueryProfile};
use serde::{Deserialize, Serialize};

/// Settings captured for one chat turn; mode and profile provenance are separate from resources.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TurnSettings {
  pub(super) configuration: QueryConfiguration,
  #[serde(deserialize_with = "Option::deserialize")]
  pub(super) applied_profile: Option<QueryProfile>,
  pub(super) mode: ChatRunMode,
}

// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

use super::ChatRunMode;
pub use crate::query_configuration::{QueryConfiguration, QueryProfile};
use infusdk::util::infu::InfuResult;
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

impl TurnSettings {
  /// Normalizes settings from a client before they are used or recorded in the transcript.
  pub(super) fn normalize(&mut self) -> InfuResult<()> {
    self.configuration.normalize()?;
    if let Some(profile) = &mut self.applied_profile {
      profile.normalize()?;
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn settings(json: serde_json::Value) -> TurnSettings {
    serde_json::from_value(json).unwrap()
  }

  #[test]
  fn client_settings_are_normalized_before_use() {
    let mut normalized = settings(serde_json::json!({
      "configuration": { "toolApproval": "automatic", "scopeId": null, "model": null, "capabilities": ["web", "infumap_data", "web"] },
      "appliedProfile": {
        "id": "0123456789abcdef0123456789abcdef",
        "name": "  Research  ",
        "configuration": { "toolApproval": "automatic", "scopeId": null, "model": null, "capabilities": ["web", "web"] },
      },
      "mode": "chat",
    }));
    normalized.normalize().unwrap();
    assert_eq!(normalized.configuration.capabilities, ["infumap_data", "web"]);
    let profile = normalized.applied_profile.unwrap();
    assert_eq!(profile.name, "Research");
    assert_eq!(profile.configuration.capabilities, ["web"]);

    let invalid = [
      serde_json::json!({ "toolApproval": "automatic", "scopeId": "not-a-uid", "model": null, "capabilities": [] }),
      serde_json::json!({ "toolApproval": "automatic", "scopeId": null, "model": { "backend": " ", "model": null, "reasoningEffort": null }, "capabilities": [] }),
      serde_json::json!({ "toolApproval": "automatic", "scopeId": null, "model": null, "capabilities": ["a\u{0}b"] }),
    ];
    for configuration in invalid {
      let mut rejected =
        settings(serde_json::json!({ "configuration": configuration, "appliedProfile": null, "mode": "chat" }));
      assert!(rejected.normalize().is_err());
    }
    let mut bad_profile = settings(serde_json::json!({
      "configuration": { "toolApproval": "automatic", "scopeId": null, "model": null, "capabilities": [] },
      "appliedProfile": { "id": "x", "name": "P", "configuration": { "toolApproval": "automatic", "scopeId": null, "model": null, "capabilities": [] } },
      "mode": "chat",
    }));
    assert!(bad_profile.normalize().is_err());
  }
}

// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

use super::super::scope::MAX_SCOPE_ITEMS;
use super::ChatRunMode;
pub use crate::query_configuration::{QueryConfiguration, QueryProfile};
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::{Uid, is_uid};
use serde::{Deserialize, Serialize};

/// Settings captured for one chat turn; mode and profile provenance are separate from resources.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TurnSettings {
  pub(super) configuration: QueryConfiguration,
  /// Items chosen in the chat, each covering itself and its descendants. When there are any, they limit Infumap
  /// tools in place of `configuration.scope_id`, which is kept so that removing them restores it. They are not part
  /// of the configuration, so profiles never carry them. Absent in turns recorded before they existed.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub(super) scope_item_ids: Vec<Uid>,
  #[serde(deserialize_with = "Option::deserialize")]
  pub(super) applied_profile: Option<QueryProfile>,
  pub(super) mode: ChatRunMode,
}

impl TurnSettings {
  /// Normalizes settings from a client before they are used or recorded in the transcript.
  pub(super) fn normalize(&mut self) -> InfuResult<()> {
    self.configuration.normalize()?;
    if self.scope_item_ids.iter().any(|id| !is_uid(id)) {
      return Err("Invalid scope item ID.".into());
    }
    // Order is kept: it is the order the user added them in.
    let mut seen = std::collections::HashSet::new();
    self.scope_item_ids.retain(|id| seen.insert(id.clone()));
    if self.scope_item_ids.len() > MAX_SCOPE_ITEMS {
      return Err(format!("At most {MAX_SCOPE_ITEMS} items can be in scope.").into());
    }
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

  #[test]
  fn scope_items_are_optional_deduplicated_in_order_and_limited() {
    let with_items = |items: serde_json::Value| {
      settings(serde_json::json!({
        "configuration": { "toolApproval": "automatic", "scopeId": null, "model": null, "capabilities": [] },
        "scopeItemIds": items,
        "appliedProfile": null,
        "mode": "chat",
      }))
    };
    let mut absent = settings(serde_json::json!({
      "configuration": { "toolApproval": "automatic", "scopeId": null, "model": null, "capabilities": [] },
      "appliedProfile": null,
      "mode": "chat",
    }));
    absent.normalize().unwrap();
    assert!(absent.scope_item_ids.is_empty());
    assert!(serde_json::to_value(&absent).unwrap().get("scopeItemIds").is_none());

    let (a, b) = ("0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210");
    let mut duplicated = with_items(serde_json::json!([b, a, b]));
    duplicated.normalize().unwrap();
    assert_eq!(duplicated.scope_item_ids, [b, a]);
    assert_eq!(serde_json::to_value(&duplicated).unwrap()["scopeItemIds"], serde_json::json!([b, a]));

    assert!(with_items(serde_json::json!(["not-a-uid"])).normalize().is_err());
    let at_limit: Vec<String> = (0..MAX_SCOPE_ITEMS).map(|i| format!("{i:032x}")).collect();
    with_items(serde_json::json!(at_limit)).normalize().unwrap();
    let over_limit: Vec<String> = (0..=MAX_SCOPE_ITEMS).map(|i| format!("{i:032x}")).collect();
    assert!(with_items(serde_json::json!(over_limit)).normalize().is_err());
  }
}

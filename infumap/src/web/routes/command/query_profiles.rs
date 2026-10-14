// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

use super::*;
use crate::query_configuration::{
  QueryConfiguration, QueryModelFavorite, QueryProfile, QueryProfileCollection, QueryProfilePreferences,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileRequest {
  expected_user_id: Uid,
  expected_revision: Option<u64>,
  #[serde(flatten)]
  operation: ProfileOperation,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum ProfileOperation {
  List,
  Create { name: String, configuration: QueryConfiguration },
  Update { id: Uid, name: String, configuration: QueryConfiguration },
  Duplicate { id: Uid, name: String },
  Delete { id: Uid, replacement_default_profile_id: Option<Uid> },
  Reorder { profile_ids: Vec<Uid> },
  SetPinned { profile_ids: Vec<Uid> },
  SetDefault { id: Uid },
  SetModelFavorites { favorites: Vec<QueryModelFavorite> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileResponse {
  user_id: Uid,
  collection: QueryProfileCollection,
  conflict: bool,
  profile_id: Option<Uid>,
  error: Option<String>,
}

fn validate_text(text: &str, field: &str, max_len: usize) -> InfuResult<()> {
  if text.trim().is_empty() || text.len() > max_len || text.chars().any(char::is_control) {
    return Err(format!("Invalid {field}.").into());
  }
  Ok(())
}

fn normalize_configuration(configuration: &mut QueryConfiguration) -> InfuResult<()> {
  if configuration.scope_id.as_ref().is_some_and(|id| !is_uid(id)) {
    return Err("Invalid scope ID.".into());
  }
  if let Some(model) = &configuration.model {
    validate_text(&model.backend, "model provider", 256)?;
    if let Some(id) = &model.model {
      validate_text(id, "model ID", 512)?;
    }
    if let Some(effort) = &model.reasoning_effort {
      validate_text(effort, "reasoning effort", 64)?;
    }
  }
  for capability in &configuration.capabilities {
    validate_text(capability, "capability ID", 128)?;
  }
  configuration.capabilities.sort();
  configuration.capabilities.dedup();
  // Availability is deliberately not checked: a removed scope, model or tool remains repairable.
  Ok(())
}

fn validate_profile_ids(ids: &[Uid], collection: &QueryProfileCollection, complete: bool) -> InfuResult<()> {
  let unique: HashSet<_> = ids.iter().collect();
  if unique.len() != ids.len()
    || (complete && ids.len() != collection.profiles.len())
    || ids.iter().any(|id| !collection.profiles.iter().any(|profile| &profile.id == id))
  {
    return Err("Profile IDs must name distinct profiles in this account.".into());
  }
  Ok(())
}

fn validate_collection(collection: &mut QueryProfileCollection) -> InfuResult<()> {
  let mut ids = HashSet::new();
  for profile in &mut collection.profiles {
    if !is_uid(&profile.id) || !ids.insert(profile.id.clone()) {
      return Err("Invalid or duplicate profile ID.".into());
    }
    profile.name = profile.name.trim().to_owned();
    validate_text(&profile.name, "profile name", 120)?;
    normalize_configuration(&mut profile.configuration)?;
  }
  validate_profile_ids(std::slice::from_ref(&collection.preferences.default_profile_id), collection, false)?;
  validate_profile_ids(&collection.preferences.pinned_profile_ids, collection, false)?;
  let mut favorites = HashSet::new();
  for favorite in &collection.preferences.model_favorites {
    validate_text(&favorite.backend, "favorite provider", 256)?;
    if let Some(id) = &favorite.model {
      validate_text(id, "favorite model", 512)?;
    }
    if !favorites.insert((&favorite.backend, &favorite.model)) {
      return Err("Duplicate model favorite.".into());
    }
  }
  Ok(())
}

fn profile_index(collection: &QueryProfileCollection, id: &Uid) -> InfuResult<usize> {
  collection.profiles.iter().position(|profile| &profile.id == id).ok_or("Profile not found in this account.".into())
}

/// Ownership comes exclusively from the validated session. Profiles and preferences are one user-log update.
pub(super) async fn handle_query_profiles(
  config: &Config,
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Not authorized to access query profiles.")?;
  let request: ProfileRequest = serde_json::from_str(json_data)?;
  if request.expected_user_id != session.user_id {
    return Err("Not authorized: the account changed while managing query profiles.".into());
  }
  let mut db = db.lock().await;
  let mut user = db.user.get(&session.user_id).ok_or("User not found.")?.clone();
  let mut collection = match &user.query_profiles {
    Some(collection) => collection.clone(),
    None => {
      let id = new_uid();
      let mut initial = QueryProfileCollection {
        revision: 0,
        profiles: vec![QueryProfile {
          id: id.clone(),
          name: "Default".to_owned(),
          configuration: chat::default_query_configuration(config)?,
        }],
        preferences: QueryProfilePreferences {
          default_profile_id: id.clone(),
          pinned_profile_ids: vec![id],
          model_favorites: vec![],
        },
      };
      validate_collection(&mut initial)?;
      user.query_profiles = Some(initial.clone());
      db.user.update(&user).await?;
      db.item.mark_user_dirty(&user.id);
      initial
    }
  };
  validate_collection(&mut collection)?;
  let mut profile_id = None;
  let mut conflict = false;
  let mut mutation_error = None;
  if !matches!(request.operation, ProfileOperation::List) {
    let expected = request.expected_revision.ok_or("Profile mutations require an expected revision.")?;
    if expected != collection.revision {
      conflict = true;
    } else {
      let mut candidate = collection.clone();
      let result = (|| -> InfuResult<Option<Uid>> {
        let mut profile_id = None;
        match request.operation {
          ProfileOperation::List => unreachable!(),
          ProfileOperation::Create { name, configuration } => {
            let id = new_uid();
            candidate.profiles.push(QueryProfile { id: id.clone(), name, configuration });
            profile_id = Some(id);
          }
          ProfileOperation::Update { id, name, configuration } => {
            let index = profile_index(&candidate, &id)?;
            candidate.profiles[index] = QueryProfile { id: id.clone(), name, configuration };
            profile_id = Some(id);
          }
          ProfileOperation::Duplicate { id, name } => {
            let index = profile_index(&candidate, &id)?;
            let mut profile = candidate.profiles[index].clone();
            profile.id = new_uid();
            profile.name = name;
            profile_id = Some(profile.id.clone());
            candidate.profiles.insert(index + 1, profile);
          }
          ProfileOperation::Delete { id, replacement_default_profile_id } => {
            let index = profile_index(&candidate, &id)?;
            if candidate.profiles.len() == 1 {
              return Err("The last query profile cannot be deleted.".into());
            }
            if candidate.preferences.default_profile_id == id {
              let replacement = replacement_default_profile_id
                .ok_or("Choose a replacement default profile before deleting the default.")?;
              if replacement == id {
                return Err("Replacement default must be a different profile.".into());
              }
              profile_index(&candidate, &replacement)?;
              candidate.preferences.default_profile_id = replacement;
            } else if replacement_default_profile_id.is_some() {
              return Err("A replacement default is only needed when deleting the default profile.".into());
            }
            candidate.profiles.remove(index);
            candidate.preferences.pinned_profile_ids.retain(|pinned| pinned != &id);
          }
          ProfileOperation::Reorder { profile_ids } => {
            validate_profile_ids(&profile_ids, &candidate, true)?;
            candidate.profiles = profile_ids
              .iter()
              .map(|id| candidate.profiles.iter().find(|profile| &profile.id == id).unwrap().clone())
              .collect();
          }
          ProfileOperation::SetPinned { profile_ids } => {
            validate_profile_ids(&profile_ids, &candidate, false)?;
            candidate.preferences.pinned_profile_ids = profile_ids;
          }
          ProfileOperation::SetDefault { id } => {
            profile_index(&candidate, &id)?;
            candidate.preferences.default_profile_id = id;
          }
          ProfileOperation::SetModelFavorites { favorites } => candidate.preferences.model_favorites = favorites,
        }
        validate_collection(&mut candidate)?;
        Ok(profile_id)
      })();
      match result {
        Err(error) => mutation_error = Some(error.message().to_owned()),
        Ok(id) => {
          profile_id = id;
          candidate.revision = candidate.revision.checked_add(1).ok_or("Profile revision overflow.")?;
          user.query_profiles = Some(candidate.clone());
          db.user.update(&user).await?;
          db.item.mark_user_dirty(&user.id);
          collection = candidate;
        }
      }
    }
  }
  Ok(Some(serde_json::to_string(&ProfileResponse {
    user_id: session.user_id.clone(),
    collection,
    conflict,
    profile_id,
    error: mutation_error,
  })?))
}

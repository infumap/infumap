// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

use super::*;
use crate::query_configuration::{
  QueryConfiguration, QueryModelFavorite, QueryProfile, QueryProfileCollection, QueryProfilePreferences,
};

/// Each mutation appends the whole collection to the user log, so its size is bounded.
const MAX_PROFILES: usize = 100;
const MAX_MODEL_FAVORITES: usize = 200;
const MAX_CAPABILITIES: usize = 64;
const MAX_PROFILE_NAME_BYTES: usize = 120;
const DUPLICATE_SUFFIX: &str = " copy";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileRequest {
  expected_user_id: Uid,
  #[serde(flatten)]
  operation: ProfileOperation,
}

/// Each operation states one intent and applies to the collection as it is when the request arrives.
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum ProfileOperation {
  List,
  Create { name: String, configuration: QueryConfiguration },
  Rename { id: Uid, name: String },
  SetConfiguration { id: Uid, configuration: QueryConfiguration },
  Duplicate { id: Uid },
  Delete { id: Uid },
  Move { id: Uid, to_index: usize },
  SetPinned { id: Uid, pinned: bool },
  SetDefault { id: Uid },
  SetModelFavorite { backend: String, model: Option<String>, favorite: bool },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileResponse {
  user_id: Uid,
  collection: QueryProfileCollection,
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
  if configuration.capabilities.len() > MAX_CAPABILITIES {
    return Err("Too many capabilities.".into());
  }
  // Availability is deliberately not checked: a removed scope, model or tool remains repairable.
  Ok(())
}

fn name_key(name: &str) -> String {
  name.to_lowercase()
}

/// Checks every invariant and normalizes names, capabilities and pin order before a collection is stored.
fn validate_collection(collection: &mut QueryProfileCollection) -> InfuResult<()> {
  if collection.profiles.is_empty() {
    return Err("At least one query profile is required.".into());
  }
  if collection.profiles.len() > MAX_PROFILES {
    return Err(format!("At most {MAX_PROFILES} query profiles are supported.").into());
  }
  let mut ids = HashSet::new();
  let mut names = HashSet::new();
  for profile in &mut collection.profiles {
    if !is_uid(&profile.id) || !ids.insert(profile.id.clone()) {
      return Err("Invalid or duplicate profile ID.".into());
    }
    profile.name = profile.name.trim().to_owned();
    validate_text(&profile.name, "profile name", MAX_PROFILE_NAME_BYTES)?;
    if !names.insert(name_key(&profile.name)) {
      return Err(format!("A profile named “{}” already exists.", profile.name).into());
    }
    normalize_configuration(&mut profile.configuration)?;
  }
  let preferences = &mut collection.preferences;
  if !ids.contains(&preferences.default_profile_id) {
    return Err("The default profile must be one of the saved profiles.".into());
  }
  let pinned: HashSet<_> = preferences.pinned_profile_ids.iter().cloned().collect();
  if pinned.iter().any(|id| !ids.contains(id)) {
    return Err("Pinned profiles must be saved profiles.".into());
  }
  preferences.pinned_profile_ids =
    collection.profiles.iter().filter(|profile| pinned.contains(&profile.id)).map(|profile| profile.id.clone()).collect();
  if preferences.model_favorites.len() > MAX_MODEL_FAVORITES {
    return Err(format!("At most {MAX_MODEL_FAVORITES} model favorites are supported.").into());
  }
  let mut favorites = HashSet::new();
  for favorite in &preferences.model_favorites {
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

/// "Name copy", or "Name copy 2" and so on when that is taken, within the name length limit.
fn duplicate_name(collection: &QueryProfileCollection, name: &str) -> String {
  let taken: HashSet<_> = collection.profiles.iter().map(|profile| name_key(&profile.name)).collect();
  (1..)
    .map(|n| {
      let suffix = if n == 1 { DUPLICATE_SUFFIX.to_owned() } else { format!("{DUPLICATE_SUFFIX} {n}") };
      let mut prefix = String::new();
      for character in name.chars() {
        if prefix.len() + character.len_utf8() + suffix.len() > MAX_PROFILE_NAME_BYTES {
          break;
        }
        prefix.push(character);
      }
      format!("{}{suffix}", prefix.trim_end())
    })
    .find(|candidate| !taken.contains(&name_key(candidate)))
    .unwrap()
}

fn apply(candidate: &mut QueryProfileCollection, operation: ProfileOperation) -> InfuResult<Option<Uid>> {
  match operation {
    ProfileOperation::List => Ok(None),
    ProfileOperation::Create { name, configuration } => {
      let id = new_uid();
      candidate.profiles.push(QueryProfile { id: id.clone(), name, configuration });
      Ok(Some(id))
    }
    ProfileOperation::Rename { id, name } => {
      let index = profile_index(candidate, &id)?;
      candidate.profiles[index].name = name;
      Ok(Some(id))
    }
    ProfileOperation::SetConfiguration { id, configuration } => {
      let index = profile_index(candidate, &id)?;
      candidate.profiles[index].configuration = configuration;
      Ok(Some(id))
    }
    ProfileOperation::Duplicate { id } => {
      let index = profile_index(candidate, &id)?;
      let mut profile = candidate.profiles[index].clone();
      profile.id = new_uid();
      profile.name = duplicate_name(candidate, &profile.name);
      let id = profile.id.clone();
      candidate.profiles.insert(index + 1, profile);
      Ok(Some(id))
    }
    ProfileOperation::Delete { id } => {
      let index = profile_index(candidate, &id)?;
      if candidate.profiles.len() == 1 {
        return Err("The last query profile cannot be deleted.".into());
      }
      candidate.profiles.remove(index);
      candidate.preferences.pinned_profile_ids.retain(|pinned| pinned != &id);
      if candidate.preferences.default_profile_id == id {
        candidate.preferences.default_profile_id = candidate.profiles[0].id.clone();
      }
      Ok(None)
    }
    ProfileOperation::Move { id, to_index } => {
      let index = profile_index(candidate, &id)?;
      if to_index >= candidate.profiles.len() {
        return Err("Profile position is out of range.".into());
      }
      let profile = candidate.profiles.remove(index);
      candidate.profiles.insert(to_index, profile);
      Ok(Some(id))
    }
    ProfileOperation::SetPinned { id, pinned } => {
      profile_index(candidate, &id)?;
      let pins = &mut candidate.preferences.pinned_profile_ids;
      pins.retain(|pinned_id| pinned_id != &id);
      if pinned {
        pins.push(id.clone());
      }
      Ok(Some(id))
    }
    ProfileOperation::SetDefault { id } => {
      profile_index(candidate, &id)?;
      candidate.preferences.default_profile_id = id.clone();
      Ok(Some(id))
    }
    ProfileOperation::SetModelFavorite { backend, model, favorite } => {
      let favorites = &mut candidate.preferences.model_favorites;
      favorites.retain(|existing| existing.backend != backend || existing.model != model);
      if favorite {
        favorites.push(QueryModelFavorite { backend, model });
      }
      Ok(None)
    }
  }
}

fn initial_collection(config: &Config) -> InfuResult<QueryProfileCollection> {
  let id = new_uid();
  Ok(QueryProfileCollection {
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
  })
}

/// Ownership comes exclusively from the validated session. Profiles and preferences are one user-log update.
/// An account without profiles gets a pinned Default profile on its first request.
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
  let is_list = matches!(request.operation, ProfileOperation::List);
  let mut collection = match &user.query_profiles {
    Some(collection) => collection.clone(),
    None => initial_collection(config)?,
  };
  let mut candidate = collection.clone();
  let result = apply(&mut candidate, request.operation).and_then(|id| validate_collection(&mut candidate).map(|_| id));
  let (profile_id, error) = match result {
    Err(error) => (None, Some(error.message().to_owned())),
    Ok(id) => {
      if !is_list {
        candidate.revision += 1;
      }
      if user.query_profiles.as_ref() != Some(&candidate) {
        user.query_profiles = Some(candidate.clone());
        db.user.update(&user).await?;
        db.item.mark_user_dirty(&user.id);
      }
      collection = candidate;
      (id, None)
    }
  };
  Ok(Some(serde_json::to_string(&ProfileResponse { user_id: session.user_id.clone(), collection, profile_id, error })?))
}

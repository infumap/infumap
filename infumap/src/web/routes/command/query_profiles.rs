// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

use super::*;
use crate::query_configuration::{
  MAX_PROFILE_NAME_BYTES, QueryConfiguration, QueryModelFavorite, QueryProfile, QueryProfileCollection,
  QueryProfilePreferences, validate_text,
};

/// Each mutation appends the whole collection to the user log, so its size is bounded.
const MAX_PROFILES: usize = 100;
const MAX_MODEL_FAVORITES: usize = 200;
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
    profile.normalize()?;
    if !ids.insert(profile.id.clone()) {
      return Err("Duplicate profile ID.".into());
    }
    if !names.insert(name_key(&profile.name)) {
      return Err(format!("A profile named “{}” already exists.", profile.name).into());
    }
  }
  let preferences = &mut collection.preferences;
  if !ids.contains(&preferences.default_profile_id) {
    return Err("The default profile must be one of the saved profiles.".into());
  }
  let pinned: HashSet<_> = preferences.pinned_profile_ids.iter().cloned().collect();
  if pinned.iter().any(|id| !ids.contains(id)) {
    return Err("Pinned profiles must be saved profiles.".into());
  }
  preferences.pinned_profile_ids = collection
    .profiles
    .iter()
    .filter(|profile| pinned.contains(&profile.id))
    .map(|profile| profile.id.clone())
    .collect();
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

fn initial_collection(configuration: QueryConfiguration) -> QueryProfileCollection {
  let id = new_uid();
  QueryProfileCollection {
    revision: 0,
    profiles: vec![QueryProfile { id: id.clone(), name: "Default".to_owned(), configuration }],
    preferences: QueryProfilePreferences {
      default_profile_id: id.clone(),
      pinned_profile_ids: vec![id],
      model_favorites: vec![],
    },
  }
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
  // Provider discovery can take time. Do it before taking the lock used to update user data,
  // then re-read the collection so concurrent first requests cannot overwrite one another.
  let needs_initial_profile = {
    let db = db.lock().await;
    db.user.get(&session.user_id).ok_or("User not found.")?.query_profiles.is_none()
  };
  let initial = if needs_initial_profile {
    Some(initial_collection(chat::default_query_configuration(config).await?))
  } else {
    None
  };
  let mut db = db.lock().await;
  let mut user = db.user.get(&session.user_id).ok_or("User not found.")?.clone();
  let is_list = matches!(request.operation, ProfileOperation::List);
  let mut collection = match &user.query_profiles {
    Some(collection) => collection.clone(),
    None => initial.ok_or("Could not initialize query profiles.")?,
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

#[cfg(test)]
mod tests {
  use super::*;
  use crate::query_configuration::{ChatModelSelection, MAX_CAPABILITIES};

  fn configuration() -> QueryConfiguration {
    QueryConfiguration {
      scope_id: None,
      model: Some(ChatModelSelection { backend: "llama:a".to_owned(), model: None, reasoning_effort: None }),
      capabilities: vec!["infumap_data".to_owned()],
      tool_approval: crate::query_configuration::ToolApproval::Automatic,
    }
  }

  /// Profiles "A", "B", "C" in that order; A is the default, A and C are pinned.
  fn collection() -> QueryProfileCollection {
    let profiles: Vec<QueryProfile> = ["A", "B", "C"]
      .iter()
      .map(|name| QueryProfile { id: new_uid(), name: (*name).to_owned(), configuration: configuration() })
      .collect();
    QueryProfileCollection {
      revision: 0,
      preferences: QueryProfilePreferences {
        default_profile_id: profiles[0].id.clone(),
        pinned_profile_ids: vec![profiles[2].id.clone(), profiles[0].id.clone()],
        model_favorites: vec![],
      },
      profiles,
    }
  }

  fn run(collection: &QueryProfileCollection, operation: ProfileOperation) -> InfuResult<QueryProfileCollection> {
    let mut candidate = collection.clone();
    apply(&mut candidate, operation)?;
    validate_collection(&mut candidate)?;
    Ok(candidate)
  }

  fn names(collection: &QueryProfileCollection, ids: &[Uid]) -> Vec<String> {
    ids.iter().map(|id| collection.profiles.iter().find(|p| &p.id == id).unwrap().name.clone()).collect()
  }

  fn order(collection: &QueryProfileCollection) -> Vec<String> {
    collection.profiles.iter().map(|profile| profile.name.clone()).collect()
  }

  #[test]
  fn pins_are_kept_in_profile_order() {
    let c = collection();
    let normalized = run(&c, ProfileOperation::List).unwrap();
    assert_eq!(names(&normalized, &normalized.preferences.pinned_profile_ids), ["A", "C"]);
    let moved = run(&c, ProfileOperation::Move { id: c.profiles[2].id.clone(), to_index: 0 }).unwrap();
    assert_eq!(order(&moved), ["C", "A", "B"]);
    assert_eq!(names(&moved, &moved.preferences.pinned_profile_ids), ["C", "A"]);
    let pinned = run(&c, ProfileOperation::SetPinned { id: c.profiles[1].id.clone(), pinned: true }).unwrap();
    assert_eq!(names(&pinned, &pinned.preferences.pinned_profile_ids), ["A", "B", "C"]);
    assert!(run(&c, ProfileOperation::Move { id: c.profiles[0].id.clone(), to_index: 3 }).is_err());
  }

  #[test]
  fn deleting_the_default_promotes_the_first_remaining_profile() {
    let c = collection();
    let deleted = run(&c, ProfileOperation::Delete { id: c.profiles[0].id.clone() }).unwrap();
    assert_eq!(order(&deleted), ["B", "C"]);
    assert_eq!(names(&deleted, &[deleted.preferences.default_profile_id.clone()]), ["B"]);
    assert_eq!(names(&deleted, &deleted.preferences.pinned_profile_ids), ["C"]);

    let mut last = collection();
    last.profiles.truncate(1);
    last.preferences.pinned_profile_ids.clear();
    assert!(run(&last, ProfileOperation::Delete { id: last.profiles[0].id.clone() }).is_err());
  }

  #[test]
  fn names_are_trimmed_and_unique_ignoring_case() {
    let c = collection();
    let renamed =
      run(&c, ProfileOperation::Rename { id: c.profiles[1].id.clone(), name: "  Bee  ".to_owned() }).unwrap();
    assert_eq!(order(&renamed), ["A", "Bee", "C"]);
    assert!(run(&c, ProfileOperation::Rename { id: c.profiles[1].id.clone(), name: "c".to_owned() }).is_err());
    assert!(run(&c, ProfileOperation::Create { name: "a".to_owned(), configuration: configuration() }).is_err());
    assert!(run(&c, ProfileOperation::Rename { id: c.profiles[1].id.clone(), name: " ".to_owned() }).is_err());
    assert!(run(&c, ProfileOperation::Rename { id: c.profiles[1].id.clone(), name: "a\nb".to_owned() }).is_err());
  }

  #[test]
  fn duplicates_get_unused_names_within_the_length_limit() {
    let c = collection();
    let once = run(&c, ProfileOperation::Duplicate { id: c.profiles[0].id.clone() }).unwrap();
    let twice = run(&once, ProfileOperation::Duplicate { id: c.profiles[0].id.clone() }).unwrap();
    assert_eq!(order(&twice), ["A", "A copy 2", "A copy", "B", "C"]);

    let mut long = collection();
    long.profiles[0].name = "é".repeat(60);
    let copy = run(&long, ProfileOperation::Duplicate { id: long.profiles[0].id.clone() }).unwrap();
    let name = &copy.profiles[1].name;
    assert!(name.len() <= MAX_PROFILE_NAME_BYTES && name.ends_with(" copy"));
  }

  #[test]
  fn configuration_is_normalized_and_capped() {
    let c = collection();
    let mut duplicated = configuration();
    duplicated.capabilities = vec!["web".to_owned(), "infumap_data".to_owned(), "web".to_owned()];
    let saved =
      run(&c, ProfileOperation::SetConfiguration { id: c.profiles[0].id.clone(), configuration: duplicated }).unwrap();
    assert_eq!(saved.profiles[0].configuration.capabilities, ["infumap_data", "web"]);

    let mut too_many = configuration();
    too_many.capabilities = (0..=MAX_CAPABILITIES).map(|n| format!("tool{n}")).collect();
    assert!(
      run(&c, ProfileOperation::SetConfiguration { id: c.profiles[0].id.clone(), configuration: too_many }).is_err()
    );

    let mut full = collection();
    full.profiles = (0..MAX_PROFILES)
      .map(|n| QueryProfile { id: new_uid(), name: format!("P{n}"), configuration: configuration() })
      .collect();
    full.preferences = QueryProfilePreferences {
      default_profile_id: full.profiles[0].id.clone(),
      pinned_profile_ids: vec![],
      model_favorites: vec![],
    };
    assert!(
      run(&full, ProfileOperation::Create { name: "One more".to_owned(), configuration: configuration() }).is_err()
    );
  }

  #[test]
  fn model_favorites_are_set_and_cleared_idempotently() {
    let c = collection();
    let favorite = |favorite| ProfileOperation::SetModelFavorite {
      backend: "openrouter".to_owned(),
      model: Some("x/y".to_owned()),
      favorite,
    };
    let added = run(&run(&c, favorite(true)).unwrap(), favorite(true)).unwrap();
    assert_eq!(added.preferences.model_favorites.len(), 1);
    assert!(run(&added, favorite(false)).unwrap().preferences.model_favorites.is_empty());
  }

  #[test]
  fn requests_reject_unknown_operation_fields() {
    let user = new_uid();
    let parse = |json: serde_json::Value| serde_json::from_value::<ProfileRequest>(json);
    assert!(parse(serde_json::json!({ "expectedUserId": user, "operation": "delete", "id": new_uid() })).is_ok());
    assert!(
      parse(serde_json::json!({ "expectedUserId": user, "operation": "delete", "id": new_uid(), "replacementDefaultProfileId": new_uid() }))
        .is_err()
    );
  }
}

// Copyright (C) The Infumap Authors
// This file is part of Infumap.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use infusdk::db::kv_store::JsonLogSerializable;
use infusdk::db::kv_store::KVStore;
use infusdk::item::TableColumn;
use infusdk::item::is_data_item_type;
use infusdk::item::is_attachments_item_type;
use infusdk::item::is_container_item_type;
use infusdk::item::is_positionable_type;
use infusdk::item::{Item, ItemType, RelationshipToParent};
use infusdk::util::geometry::GRID_SIZE;
use infusdk::util::geometry::Vector;
use infusdk::util::infu::{InfuError, InfuResult};
use infusdk::util::json;
use infusdk::util::time::unix_now_secs_i64;
use infusdk::util::uid::Uid;
use log::{debug, info, warn};
use serde_json::{Map, Number, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, BufReader};

use crate::util::fs::{expand_tilde, path_exists};
use crate::util::mime::{mime_type_from_title_extension, normalized_mime_type};

use super::user::User;

pub const CURRENT_ITEM_LOG_VERSION: i64 = 29;

#[derive(Clone, Default)]
pub struct MimeTypeMigrationState {
  pub is_data_item: bool,
  pub title: Option<String>,
  pub mime_type: Option<String>,
}

#[derive(Default)]
pub struct MimeTypeMigrationStats {
  scanned_records: usize,
  changed_records: usize,
  changed_entry_records: usize,
  changed_update_records: usize,
  changed_item_ids: HashSet<String>,
  changed_mime_types: BTreeMap<(String, String), usize>,
}

impl MimeTypeMigrationStats {
  pub fn record_change(&mut self, item_id: &str, record_type: &str, from: Option<&str>, to: &str) {
    self.changed_records += 1;
    self.changed_item_ids.insert(item_id.to_owned());
    *self.changed_mime_types.entry((from.unwrap_or("<missing>").to_owned(), to.to_owned())).or_insert(0) += 1;
    match record_type {
      "entry" => self.changed_entry_records += 1,
      "update" => self.changed_update_records += 1,
      _ => {}
    }
  }

  pub fn render_summary(&self) -> Vec<String> {
    let mut lines = vec![
      format!("Scanned {} item records.", self.scanned_records),
      format!(
        "Changed MIME type on {} records across {} items.",
        self.changed_records,
        self.changed_item_ids.len()
      ),
    ];
    if self.changed_records > 0 {
      lines.push(format!(
        "Changed entry records: {}. Changed update records: {}.",
        self.changed_entry_records, self.changed_update_records
      ));
      for ((from, to), count) in &self.changed_mime_types {
        lines.push(format!("{} -> {}: {}", from, to, count));
      }
    }
    lines
  }
}

#[derive(PartialEq, Eq, Hash, Clone)]
pub struct ItemAndUserId {
  pub user_id: Uid,
  pub item_id: Uid,
}

/// Db for Item instances for all users, assuming the mandated data folder hierarchy.
/// Not thread safe.
pub struct ItemDb {
  data_dir: String,
  store_by_user_id: HashMap<Uid, KVStore<Item>>,
  dirty_user_ids: HashSet<Uid>,

  // indexes
  owner_id_by_item_id: HashMap<Uid, Uid>,
  children_of: HashMap<Uid, Vec<Uid>>,
  attachments_of: HashMap<Uid, Vec<Uid>>,
}

impl ItemDb {
  pub fn init(data_dir: &str) -> ItemDb {
    ItemDb {
      data_dir: String::from(data_dir),
      store_by_user_id: HashMap::new(),
      dirty_user_ids: HashSet::new(),
      owner_id_by_item_id: HashMap::new(),
      children_of: HashMap::new(),
      attachments_of: HashMap::new(),
    }
  }

  /// Compact a user's item database.
  ///
  /// In general it is not possible to maintain chronological ordering because items can be moved between parents
  /// and deleted arbitrarily, so no attempt is made to do so to any degree at all.
  ///
  /// Ordering in the output log is according to the parent/child hierarchy - no item is written in the compacted
  /// log before it's parent.
  pub async fn compact(&self, user: &User) -> InfuResult<()> {
    let store = self.store_by_user_id.get(&user.id).ok_or(format!("no item store for user: {}", &user.id))?;
    let root_ids = vec![user.trash_page_id.as_str(), user.dock_page_id.as_str(), user.home_page_id.as_str()];

    let mut all_ids = store.get_iter().map(|e| e.1.id.as_str()).collect::<HashSet<&str>>();
    let mut ordered_ids = vec![];
    for root_id in root_ids {
      let _ = store.get(root_id).ok_or(format!("root item doesn't exist: {}", root_id))?;
      let mut stack = vec![root_id];
      loop {
        let current_id = match stack.pop() {
          Some(s) => s,
          None => {
            break;
          }
        };
        ordered_ids.push(current_id);
        all_ids.remove(current_id);
        if let Some(children) = self.children_of.get(current_id) {
          for c in children {
            stack.push(c);
          }
        }
        if let Some(attachments) = self.attachments_of.get(current_id) {
          for a in attachments {
            stack.push(a);
          }
        }
      }
    }
    let orphaned_ids = all_ids;

    if orphaned_ids.len() > 0 {
      warn!("There are {} unreachable items that will not be written to the compacted database.", orphaned_ids.len());
      for id in &orphaned_ids {
        let item = store.get(id).ok_or(format!("Orphaned item {} was not present in the store", id))?;
        println!("Orphaned item: {:?}", item);
      }
    } else {
      info!("All items are reachable and will be written to the compacted database.");
    }

    let mut log_path = expand_tilde(&self.data_dir).ok_or("Could not interpret path.")?;
    log_path.push(String::from("user_") + &user.id);
    log_path.push("items.json.compacted");
    if path_exists(&log_path).await {
      return Err(format!("Compacted log path already exists: {:?}", log_path).into());
    }

    let mut compacted_store: KVStore<Item> =
      KVStore::init(log_path.to_str().ok_or("unable to interpret path")?, CURRENT_ITEM_LOG_VERSION).await?;
    for item_id in &ordered_ids {
      compacted_store.add(store.get(item_id).unwrap().clone()).await?;
    }
    // TODO (MEDIUM): make a new "orphaned" folder under home_page for these and put them in that, not directly on the home page.
    for item_id in &orphaned_ids {
      let mut item = store.get(item_id).unwrap().clone();
      item.parent_id = Some(user.home_page_id.clone());
      item.spatial_position_gr = Some(Vector { x: 0, y: 0 });
      compacted_store.add(item).await?;
    }
    let number_written = ordered_ids.len() + orphaned_ids.len();
    info!("Wrote {} items to the compacted log.", number_written);

    Ok(())
  }

  pub async fn load_user_items(&mut self, user_id: &str, creating: bool) -> InfuResult<()> {
    info!("Loading items for user {}{}.", user_id, if creating { " (creating)" } else { "" });

    let log_path = self.log_path(user_id)?;
    let log_path_str = log_path.as_path().to_str().unwrap();

    if creating {
      if path_exists(&log_path).await {
        return Err(format!("Items log file '{}' already exists for user '{}'.", log_path_str, user_id).into());
      }
    } else {
      if !path_exists(&log_path).await {
        return Err(format!("Items log file '{}' does not exist for user '{}'.", log_path_str, user_id).into());
      }
    }

    let store: KVStore<Item> = KVStore::init(log_path_str, CURRENT_ITEM_LOG_VERSION).await?;
    for (_id, item) in store.get_iter() {
      self.add_to_indexes(item)?;
    }
    self.store_by_user_id.insert(String::from(user_id), store);

    Ok(())
  }

  fn add_to_indexes(&mut self, item: &Item) -> InfuResult<()> {
    self.owner_id_by_item_id.insert(item.id.clone(), item.owner_id.clone());
    match &item.parent_id {
      Some(parent_id) => match item.relationship_to_parent {
        RelationshipToParent::Child => match self.children_of.get_mut(parent_id) {
          Some(children) => {
            children.push(item.id.clone());
          }
          None => {
            self.children_of.insert(parent_id.clone(), vec![item.id.clone()]);
          }
        },
        RelationshipToParent::Attachment => match self.attachments_of.get_mut(parent_id) {
          Some(attachments) => {
            attachments.push(item.id.clone());
          }
          None => {
            self.attachments_of.insert(parent_id.clone(), vec![item.id.clone()]);
          }
        },
        RelationshipToParent::NoParent => {
          return Err(
            format!(
              "'no-parent' relationship to parent for item '{}' is not valid because it is not a root item.",
              item.id
            )
            .into(),
          );
        }
      },
      None => {
        if item.relationship_to_parent != RelationshipToParent::NoParent {
          return Err(
            format!(
              "Relationship to parent for root page item '{}' must be 'no-parent', not '{}'.",
              item.id,
              item.relationship_to_parent.as_str()
            )
            .into(),
          );
        }
      }
    }
    Ok(())
  }

  fn remove_from_indexes(&mut self, item: &Item) -> InfuResult<()> {
    self
      .owner_id_by_item_id
      .remove(&item.id)
      .ok_or(format!("Item '{}' is missing in the owner_id_by_item_id map.", item.id))?;

    match &item.parent_id {
      Some(parent_id) => match item.relationship_to_parent {
        RelationshipToParent::Child => {
          let parent_child_list = self
            .children_of
            .remove(parent_id)
            .ok_or(format!("Item '{}' parent '{}' is missing a children_of index.", item.id, parent_id))?;
          let updated_parent_child_list =
            parent_child_list.iter().filter(|el| **el != item.id).map(|v| v.clone()).collect::<Vec<String>>();
          if updated_parent_child_list.len() > 0 {
            self.children_of.insert(parent_id.clone(), updated_parent_child_list);
          }
        }
        RelationshipToParent::Attachment => {
          let parent_attachment_list = self
            .attachments_of
            .remove(parent_id)
            .ok_or(format!("Item '{}' parent '{}' is missing a attachment_of index.", item.id, parent_id))?;
          let updated_parent_attachment_list =
            parent_attachment_list.iter().filter(|el| **el != item.id).map(|v| v.clone()).collect::<Vec<String>>();
          if updated_parent_attachment_list.len() > 0 {
            self.attachments_of.insert(parent_id.clone(), updated_parent_attachment_list);
          }
        }
        RelationshipToParent::NoParent => {
          return Err(
            format!(
              "'no-parent' relationship to parent for item '{}' is not valid because it is not a root item.",
              item.id
            )
            .into(),
          );
        }
      },
      None => {
        if item.relationship_to_parent != RelationshipToParent::NoParent {
          return Err(
            format!(
              "Relationship to parent for root page item '{}' must be 'no-parent', not '{}'.",
              item.id,
              item.relationship_to_parent.as_str()
            )
            .into(),
          );
        }
      }
    }

    Ok(())
  }

  pub async fn add(&mut self, item: Item) -> InfuResult<()> {
    self.dirty_user_ids.insert(item.owner_id.clone());
    self
      .store_by_user_id
      .get_mut(&item.owner_id)
      .ok_or(format!("Item store has not been loaded for user '{}'.", item.owner_id))?
      .add(item.clone())
      .await?;
    self.add_to_indexes(&item)
  }

  pub async fn remove(&mut self, id: &Uid) -> InfuResult<Item> {
    let owner_id = self
      .owner_id_by_item_id
      .get(id)
      .ok_or(format!("Unknown item '{}' - corresponding user item store may not be loaded.", id))?;

    if let Some(children) = self.children_of.get(id) {
      if children.len() > 0 {
        return Err(
          format!("Cannot remove item '{}' because it has child items. {} of them.", id, children.len()).into(),
        );
      }
    }

    if let Some(attachments) = self.attachments_of.get(id) {
      if attachments.len() > 0 {
        return Err(
          format!("Cannot remove item '{}' because it has attachment items. {} of them.", id, attachments.len()).into(),
        );
      }
    }

    let store =
      self.store_by_user_id.get(owner_id).ok_or(format!("Item store is not loaded for user '{}'.", owner_id))?;
    let item_to_check = store.get(id).ok_or(format!("Item with id '{}' is missing.", id))?;

    if item_to_check.relationship_to_parent == RelationshipToParent::NoParent {
      return Err(format!("Cannot remove item '{}' because it is a root page for user '{}'.", id, owner_id).into());
    }

    // Now that all validations have passed, mark as dirty and remove the item
    self.dirty_user_ids.insert(owner_id.clone());
    let store =
      self.store_by_user_id.get_mut(owner_id).ok_or(format!("Item store is not loaded for user '{}'.", owner_id))?;
    let item = store.remove(id).await?;

    self.remove_from_indexes(&item)?;
    Ok(item)
  }

  pub async fn update(&mut self, item: &Item) -> InfuResult<()> {
    let old_item = self
      .store_by_user_id
      .get(&item.owner_id)
      .ok_or(format!("Item store has not been loaded for user '{}'.", item.owner_id))?
      .get(&item.id)
      .ok_or(format!("Request was made to update item '{}', but it does not exist.", item.id))?
      .clone();

    let update_json_map = Item::create_json_update(&old_item, item)?;
    if update_json_map.len() == 2 {
      // "__recordType" and "id" and nothing else.
      debug!("Request was made to update item '{}', but nothing has changed.", item.id);
      return Ok(());
    }

    // Paranoid validation of various circumstances which should never occur unless there is a bug on the client.
    if let Some(parent_id_value) = update_json_map.get("parentId") {
      if let Some(parent_id) = parent_id_value.as_str() {
        if parent_id == &item.id {
          return Err(format!("Request was made to update the parent of item '{}' to be itself.", item.id).into());
        }
        let parent_item_maybe = self
          .store_by_user_id
          .get(&item.owner_id)
          .ok_or(format!("Item store has not been loaded for user '{}'.", item.owner_id))?
          .get(parent_id);
        if let Some(parent_item) = parent_item_maybe {
          let relationship_to_parent = match update_json_map.get("relationshipToParent") {
            Some(rtp) => {
              let rtp_str = rtp.as_str().ok_or(InfuError::new(&format!(
                "Expected property relationshipToParent of item '{}' to have type string.",
                item.id
              )))?;
              RelationshipToParent::from_str(rtp_str)?
            }
            None => old_item.relationship_to_parent.clone(),
          };
          match relationship_to_parent {
            RelationshipToParent::Child => {
              if !is_container_item_type(parent_item.item_type) {
                return Err(format!("Request was made to update the parent of item '{}' to '{}' (relationship to parent 'child'), but it is not a container item.", item.id, parent_id).into());
              }
            }
            RelationshipToParent::Attachment => {
              if !is_attachments_item_type(parent_item.item_type) {
                return Err(format!("Request was made to update the parent of item '{}' to '{}' (relationship to parent 'attachment'), but it is not an attachments item.", item.id, parent_id).into());
              }
            }
            RelationshipToParent::NoParent => {
              return Err(
                format!(
                  "Request was made to update the parent of item '{}' to '{}', but it is a root item.",
                  item.id, parent_id
                )
                .into(),
              );
            }
          }
        } else {
          return Err(
            format!(
              "Request was made to update the parent of item '{}' to an item '{}' that doesn't exist.",
              item.id, parent_id
            )
            .into(),
          );
        }
      } else {
        return Err(format!("Expected property parentId of item '{}' to have type string.", item.id).into());
      }
    }

    self.remove_from_indexes(&old_item)?;
    self
      .store_by_user_id
      .get_mut(&item.owner_id)
      .ok_or(format!("Item store has not been loaded for user '{}'.", item.owner_id))?
      .update(item.clone())
      .await?;
    self.dirty_user_ids.insert(item.owner_id.clone());
    self.add_to_indexes(item)
  }

  pub fn get(&self, id: &Uid) -> InfuResult<&Item> {
    let owner_id = self
      .owner_id_by_item_id
      .get(id)
      .ok_or(format!("Unknown item '{}' - corresponding user item store might not be loaded.", id))?;
    let store =
      self.store_by_user_id.get(owner_id).ok_or(format!("Item store is not loaded for user '{}'.", owner_id))?;
    Ok(store.get(id).ok_or(format!("Item with id '{}' is missing.", id))?)
  }

  pub fn get_children(&self, parent_id: &Uid) -> InfuResult<Vec<&Item>> {
    let owner_id = self
      .owner_id_by_item_id
      .get(parent_id)
      .ok_or(format!("Unknown item '{}' - corresponding user item store might not be loaded.", parent_id))?;
    let store =
      self.store_by_user_id.get(owner_id).ok_or(format!("Item store is not loaded for user '{}'.", owner_id))?;
    let children = self
      .children_of
      .get(parent_id)
      .unwrap_or(&vec![])
      .iter()
      .map(|id| store.get(&id))
      .collect::<Option<Vec<&Item>>>()
      .ok_or(format!("One or more children of '{}' are missing.", parent_id))?;
    Ok(children)
  }

  pub fn get_children_ids(&self, parent_id: &Uid) -> InfuResult<Vec<String>> {
    let children = self.children_of.get(parent_id).unwrap_or(&vec![]).iter().map(|c| (*c).clone()).collect();
    Ok(children)
  }

  pub fn get_attachments(&self, parent_id: &Uid) -> InfuResult<Vec<&Item>> {
    let owner_id = self
      .owner_id_by_item_id
      .get(parent_id)
      .ok_or(format!("Unknown item '{}' - corresponding user item store may not be loaded.", parent_id))?;
    let store =
      self.store_by_user_id.get(owner_id).ok_or(format!("Item store is not loaded for user '{}'.", owner_id))?;
    let attachments = self
      .attachments_of
      .get(parent_id)
      .unwrap_or(&vec![])
      .iter()
      .map(|id| store.get(&id))
      .collect::<Option<Vec<&Item>>>()
      .ok_or(format!("One or more attachments of '{}' are missing.", parent_id))?;
    Ok(attachments)
  }

  pub fn get_attachment_ids(&self, parent_id: &Uid) -> InfuResult<Vec<String>> {
    let children = self.attachments_of.get(parent_id).unwrap_or(&vec![]).iter().map(|a| (*a).clone()).collect();
    Ok(children)
  }

  pub fn all_loaded_items(&self) -> Vec<ItemAndUserId> {
    // TODO (LOW): Proper use of iterators...
    let mut result = vec![];
    for v in self.owner_id_by_item_id.iter() {
      result.push(ItemAndUserId { item_id: v.0.clone(), user_id: v.1.clone() });
    }
    result
  }

  pub fn all_dirty_user_ids(&mut self) -> Vec<String> {
    let result = self
      .store_by_user_id
      .iter()
      .filter(|kv| self.dirty_user_ids.contains(kv.0))
      .map(|s| s.0.clone())
      .collect::<Vec<String>>();
    self.dirty_user_ids.clear();
    result
  }

  pub async fn get_log_size_bytes_for_user(&self, user_id: &str) -> InfuResult<u32> {
    let log_path = self.log_path(user_id)?;
    Ok(tokio::fs::metadata(log_path).await?.len() as u32)
  }

  pub async fn backup_user(&self, user_id: &str, buf: &mut [u8]) -> InfuResult<()> {
    let log_path = self.log_path(user_id)?;
    let mut f = BufReader::new(File::open(&log_path).await?);
    f.read_exact(buf).await?;
    Ok(())
  }

  fn log_path(&self, user_id: &str) -> InfuResult<PathBuf> {
    let mut log_path = expand_tilde(&self.data_dir).ok_or("Could not interpret path.")?;
    log_path.push(String::from("user_") + user_id);
    log_path.push("items.json");
    Ok(log_path)
  }
}

fn migrate_descriptor(kvs: &Map<String, Value>, expected_version: i64) -> InfuResult<Map<String, Value>> {
  let descriptor_version =
    json::get_integer_field(kvs, "version")?.ok_or("Descriptor 'version' field is not present.")?;
  if descriptor_version != expected_version {
    return Err(format!("Descriptor version is {}, but {} was expected.", descriptor_version, expected_version).into());
  }
  let value_type = json::get_string_field(kvs, "valueType")?.ok_or("Descriptor 'valueType' field is not present.")?;
  if value_type != Item::value_type_identifier() {
    return Err(
      format!("Descriptor value_type is '{}', expecting '{}'.", &value_type, Item::value_type_identifier()).into(),
    );
  }
  let mut result = kvs.clone();
  result.insert(String::from("version"), Value::Number(((expected_version + 1) as i64).into()));
  return Ok(result);
}

pub fn migrate_record_v1_to_v2(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      let descriptor_version =
        json::get_integer_field(kvs, "version")?.ok_or("Descriptor 'version' field is not present.")?;
      if descriptor_version != 1 {
        return Err(format!("Descriptor version is {}, but 1 was expected.", descriptor_version).into());
      }
      let value_type =
        json::get_string_field(kvs, "valueType")?.ok_or("Descriptor 'valueType' field is not present.")?;
      if value_type != Item::value_type_identifier() {
        return Err(
          format!("Descriptor value_type is '{}', expecting '{}'.", &value_type, Item::value_type_identifier()).into(),
        );
      }
      let mut result = kvs.clone();
      result.insert(String::from("version"), Value::Number((2 as i64).into()));
      return Ok(result);
    }

    "entry" => {
      let mut result = kvs.clone();
      result.remove(&String::from("__version"));
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "table" {
        let existing = result.insert(
          String::from("tableColumns"),
          json::table_columns_to_array(&vec![TableColumn { name: String::from("Title"), width_gr: 8 * GRID_SIZE }]),
        );
        if existing.is_some() {
          return Err("tableColumns field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      let mut result = kvs.clone();
      result.remove(&String::from("__version"));
      return Ok(result);
    }

    "delete" => {
      let mut result = kvs.clone();
      result.remove(&String::from("__version"));
      return Ok(result);
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

pub fn migrate_record_v2_to_v3(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 2);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "page" {
        let existing = result.insert(String::from("gridNumberOfColumns"), Value::Number((10 as i64).into()));
        if existing.is_some() {
          return Err("gridNumberOfColumns field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

pub fn migrate_record_v3_to_v4(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 3);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "page" || item_type == "table" {
        let existing = result.insert(String::from("orderChildrenBy"), Value::String(("").into()));
        if existing.is_some() {
          return Err("orderChildrenBy field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add linkToBaseUrl field to link items.
 */
pub fn migrate_record_v4_to_v5(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 4);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "link" {
        let existing = result.insert(String::from("linkToBaseUrl"), Value::String(("").into()));
        if existing.is_some() {
          return Err("linkToBaseUrl field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Rename linkToId -> linkTo.
 */
pub fn migrate_record_v5_to_v6(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 5);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "link" {
        let existing = result.remove("linkToId");
        match existing {
          None => return Err("linkToId missing".into()),
          Some(s) => {
            let existing_new = result.insert(String::from("linkTo"), s);
            if existing_new.is_some() {
              return Err("linkTo field already exists.".into());
            }
          }
        }
      }
      return Ok(result);
    }

    "update" => {
      let mut result = kvs.clone();
      let existing = result.remove("linkToId");
      match existing {
        None => {}
        Some(s) => {
          let existing_new = result.insert(String::from("linkTo"), s);
          if existing_new.is_some() {
            return Err("linkTo field already exists.".into());
          }
        }
      }
      return Ok(result);
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add showHeader field to table items.
 */
pub fn migrate_record_v6_to_v7(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 6);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "table" {
        let existing = result.insert(String::from("showHeader"), Value::Bool(false));
        if existing.is_some() {
          return Err("showHeader field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add 'flags' field to table and note item types and remove table showHeader field, converting it to be flag = 0x0001.
 */
pub fn migrate_record_v7_to_v8(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 7);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "table" {
        let existing = result.remove("showHeader");
        match existing {
          None => return Err("showHeader missing".into()),
          Some(s) => {
            let v = match s {
              Value::Bool(b) => b,
              _ => return Err("showHeader has unexpected type".into()),
            };
            let existing_new = result.insert(String::from("flags"), Value::Number((if v { 1 } else { 0 }).into()));
            if existing_new.is_some() {
              return Err("flags field already exists.".into());
            }
          }
        }
      } else if item_type == "note" {
        let existing_new = result.insert(String::from("flags"), Value::Number(0.into()));
        if existing_new.is_some() {
          return Err("flags field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      let mut result = kvs.clone();
      let existing = result.remove("showHeader");
      match existing {
        None => return Ok(result),
        Some(s) => {
          let v = match s {
            Value::Bool(b) => b,
            _ => return Err("showHeader has unexpected type".into()),
          };
          let existing_new = result.insert(String::from("flags"), Value::Number((if v { 1 } else { 0 }).into()));
          if existing_new.is_some() {
            return Err("flags field already exists.".into());
          }
        }
      }
      return Ok(result);
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add permissionFlags field to page items.
 */
pub fn migrate_record_v8_to_v9(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 8);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "page" {
        let existing = result.insert(String::from("permissionFlags"), Value::Number(0.into()));
        if existing.is_some() {
          return Err("permissionFlags field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add flags field to composite items.
 */
pub fn migrate_record_v9_to_v10(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 9);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "composite" {
        let existing = result.insert(String::from("flags"), Value::Number(0.into()));
        if existing.is_some() {
          return Err("flags field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add format field to note items.
 */
pub fn migrate_record_v10_to_v11(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 10);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "note" {
        let existing = result.insert(String::from("format"), Value::String(("").into()));
        if existing.is_some() {
          return Err("format field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add docWidthBl field to page items.
 */
pub fn migrate_record_v11_to_v12(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 11);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "page" {
        let existing = result.insert(String::from("docWidthBl"), Value::Number((36 as i64).into()));
        if existing.is_some() {
          return Err("docWidthBl field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add docWidthBl field to page items.
 */
pub fn migrate_record_v12_to_v13(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 12);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "page" {
        let existing = result.insert(
          String::from("justifiedRowAspect"),
          Value::Number(Number::from_f64(7.0 as f64).ok_or("invalid justifiedRowAspect")?),
        );
        if existing.is_some() {
          return Err("justifiedRowAspect field already exists.".into());
        }
      }
      if item_type == "page" {
        let existing = result.insert(
          String::from("gridCellAspect"),
          Value::Number(Number::from_f64(1.5 as f64).ok_or("invalid gridCellAspect")?),
        );
        if existing.is_some() {
          return Err("gridCellAspect field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add flags field to page items.
 */
pub fn migrate_record_v13_to_v14(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 13);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "page" {
        let existing = result.insert(String::from("flags"), Value::Number(0.into()));
        if existing.is_some() {
          return Err("flags field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Combine linkTo and linkToBaseUrl
 */
pub fn migrate_record_v14_to_v15(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 14);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "link" {
        let existing = result.remove("linkToBaseUrl");
        // if not specified, linkToBaseUrl is "".
        if existing.is_none() {
          return Err("link item entry does not have linkToBaseUrl field.".into());
        }
        let existing = existing.unwrap();
        let existing = existing.as_str().unwrap().to_owned();
        let existing = if !existing.ends_with("/") { format!("{}/", existing) } else { existing };
        let link_to = result.remove("linkTo");
        if link_to.is_none() {
          return Err("link item entry does not have linkTo field.".into());
        }
        let link_to = link_to.unwrap().as_str().unwrap().to_owned();
        let new_link_to = format!("{}{}", existing, link_to);
        result.insert("linkTo".to_owned(), Value::String(new_link_to).into());
      }
      return Ok(result);
    }

    "update" => {
      let mut result = kvs.clone();
      let existing = result.remove("linkToBaseUrl");
      if existing.is_some() {
        let link_to = result.remove("linkTo");
        if link_to.is_none() {
          warn!("link item update had linkToBaseUrl and no linkTo - throwing away linkToBaseUrl.");
        } else {
          let existing = existing.unwrap();
          let existing = existing.as_str().unwrap().to_owned();
          let existing = if !existing.ends_with("/") { format!("{}/", existing) } else { existing };
          let link_to = link_to.unwrap().as_str().unwrap().to_owned();
          let new_link_to = format!("{}{}", existing, link_to);
          result.insert("linkTo".to_owned(), Value::String(new_link_to).into());
        }
      }
      return Ok(result);
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add flags field to image items.
 */
pub fn migrate_record_v15_to_v16(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 15);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "image" {
        let existing = result.insert(String::from("flags"), Value::Number(0.into()));
        if existing.is_some() {
          return Err("flags field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add numberOfVisibleColumns field to table items.
 */
pub fn migrate_record_v16_to_v17(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 16);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "table" {
        let tc = kvs.get("tableColumns").ok_or("tableColumns field is not present")?;
        let tca = tc.as_array().ok_or("tableColumns field is not an array")?;
        // actual tca.len will always be one.
        let existing = result.insert(String::from("numberOfVisibleColumns"), Value::Number(tca.len().into()));
        if existing.is_some() {
          return Err("numberOfVisibleColumns field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      let mut result = kvs.clone();
      match kvs.get("tableColumns") {
        None => {}
        Some(tc) => {
          let tca = tc.as_array().ok_or("tableColumns field is not an array")?;
          let existing = result.insert(String::from("numberOfVisibleColumns"), Value::Number(tca.len().into()));
          if existing.is_some() {
            return Err("numberOfVisibleColumns field already exists.".into());
          }
        }
      }
      return Ok(result);
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add flags field to expression items.
 */
pub fn migrate_record_v17_to_v18(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 17);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "expression" {
        let existing = result.insert(String::from("flags"), Value::Number(0.into()));
        if existing.is_some() {
          return Err("flags field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add format field to expression items.
 */
pub fn migrate_record_v18_to_v19(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 18);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "expression" {
        let existing = result.insert(String::from("format"), Value::String(("").into()));
        if existing.is_some() {
          return Err("format field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add table related fields to page items.
 */
pub fn migrate_record_v19_to_v20(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 19);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "page" {
        let existing = result.insert(String::from("numberOfVisibleColumns"), Value::Number(1.into()));
        if existing.is_some() {
          return Err("numberOfVisibleColumns field already exists.".into());
        }
        let table_columns = vec![TableColumn { width_gr: 480, name: "Title".to_owned() }];
        let existing = result.insert(String::from("tableColumns"), json::table_columns_to_array(&table_columns));
        if existing.is_some() {
          return Err("tableColumns field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add scale field to flipcard items.
 */
pub fn migrate_record_v20_to_v21(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 20);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "flipcard" {
        let existing =
          result.insert(String::from("scale"), Value::Number(Number::from_f64(1.0 as f64).ok_or("invalid scale")?));
        if existing.is_some() {
          return Err("scale field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add datetime field to all items.
 */
pub fn migrate_record_v21_to_v22(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 21);
    }

    "entry" => {
      let mut result = kvs.clone();
      let creation_date = match json::get_integer_field(kvs, "creationDate")? {
        Some(date) => date,
        None => {
          warn!(
            "Entry record missing 'creationDate' field during v21 to v22 migration, using current time as fallback"
          );
          unix_now_secs_i64()?
        }
      };
      let existing = result.insert(String::from("dateTime"), Value::Number(creation_date.into()));
      if existing.is_some() {
        return Err("dateTime field already exists.".into());
      }

      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if is_positionable_type(ItemType::from_str(&item_type)?) {
        let existing =
          result.insert(String::from("calendarPositionGr"), json::vector_to_object(&Vector { x: 0, y: 0 }));
        if existing.is_some() {
          return Err("calendarPositionGr field already exists.".into());
        }
      }

      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add calendarDayRowHeightBl field to page items with default value 1.0.
 */
pub fn migrate_record_v22_to_v23(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 22);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "page" {
        let existing = result.insert(
          String::from("calendarDayRowHeightBl"),
          Value::Number(Number::from_f64(1.0 as f64).ok_or("invalid calendarDayRowHeightBl")?),
        );
        if existing.is_some() {
          return Err("calendarDayRowHeightBl field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

pub fn migrate_record_v23_to_v24(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 23);
    }

    "entry" => {
      let mut result = kvs.clone();
      result.remove("calendarPositionGr");
      return Ok(result);
    }

    "update" => {
      let mut result = kvs.clone();
      result.remove("calendarPositionGr");
      return Ok(result);
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

/**
 * Add ratingType field to rating items, defaulting to "Star".
 */
pub fn migrate_record_v24_to_v25(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 24);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "rating" {
        let existing = result.insert(String::from("ratingType"), Value::String(("Star").into()));
        if existing.is_some() {
          return Err("ratingType field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      return Ok(kvs.clone());
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

pub fn migrate_record_v25_to_v26(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 25);
    }

    "entry" => {
      let mut result = kvs.clone();
      result.remove("popupAlignmentPoint");
      return Ok(result);
    }

    "update" => {
      let mut result = kvs.clone();
      result.remove("popupAlignmentPoint");
      return Ok(result);
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

pub fn migrate_record_v26_to_v27(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 26);
    }

    "entry" => {
      let mut result = kvs.clone();
      let item_type = json::get_string_field(kvs, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      if item_type == "page" {
        let pos = result.remove("popupPositionGr").ok_or("popupPositionGr field missing")?;
        let existing = result.insert(String::from("defaultPopupPositionGr"), pos);
        if existing.is_some() {
          return Err("defaultPopupPositionGr field already exists.".into());
        }

        let width = result.remove("popupWidthGr").ok_or("popupWidthGr field missing")?;
        let existing = result.insert(String::from("defaultPopupWidthGr"), width);
        if existing.is_some() {
          return Err("defaultPopupWidthGr field already exists.".into());
        }
      }
      return Ok(result);
    }

    "update" => {
      let mut result = kvs.clone();
      if let Some(pos) = result.remove("popupPositionGr") {
        result.insert(String::from("defaultPopupPositionGr"), pos);
      }
      if let Some(width) = result.remove("popupWidthGr") {
        result.insert(String::from("defaultPopupWidthGr"), width);
      }
      return Ok(result);
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

pub fn migrate_record_v27_to_v28(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      return migrate_descriptor(kvs, 27);
    }

    "entry" => {
      let mut result = kvs.clone();
      migrate_mime_type_field(&mut result)?;
      return Ok(result);
    }

    "update" => {
      let mut result = kvs.clone();
      migrate_mime_type_field(&mut result)?;
      return Ok(result);
    }

    "delete" => {
      return Ok(kvs.clone());
    }

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}

fn migrate_mime_type_field(kvs: &mut Map<String, Value>) -> InfuResult<()> {
  if let Some(mime_type) = json::get_string_field(kvs, "mimeType")? {
    kvs.insert(String::from("mimeType"), Value::String(normalized_mime_type(&mime_type)));
  }
  Ok(())
}

pub fn migrate_record_v28_to_v29(
  kvs: &Map<String, Value>,
  state_by_id: &mut HashMap<String, MimeTypeMigrationState>,
  stats: &mut MimeTypeMigrationStats,
) -> InfuResult<Map<String, Value>> {
  stats.scanned_records += 1;

  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => migrate_descriptor(kvs, 28),
    "entry" => {
      let mut result = kvs.clone();
      let item_id = json::get_string_field(&result, "id")?.ok_or("Entry record is missing id.")?;
      let item_type = json::get_string_field(&result, "itemType")?.ok_or("Entry record does not have 'itemType' field.")?;
      let item_type = ItemType::from_str(&item_type)?;
      if is_data_item_type(item_type) {
        maybe_fix_mime_type_from_title(&mut result, None, None, stats, "entry")?;
      }
      state_by_id.insert(item_id, mime_type_migration_state_from_entry(&result, item_type)?);
      Ok(result)
    }
    "update" => {
      let mut result = kvs.clone();
      let item_id = json::get_string_field(kvs, "id")?.ok_or("Update record does not have 'id' field.")?;
      let previous_state =
        state_by_id.get(&item_id).ok_or(format!("Update record has id '{}', but this is unknown.", item_id))?.clone();
      if previous_state.is_data_item {
        maybe_fix_mime_type_from_title(
          &mut result,
          previous_state.title.as_deref(),
          previous_state.mime_type.as_deref(),
          stats,
          "update",
        )?;
      }
      let updated_state = apply_mime_type_migration_update(&previous_state, &result)?;
      state_by_id.insert(item_id, updated_state);
      Ok(result)
    }
    "delete" => {
      let item_id = json::get_string_field(kvs, "id")?.ok_or("Delete record does not have 'id' field.")?;
      state_by_id.remove(&item_id);
      Ok(kvs.clone())
    }
    unexpected_record_type => Err(format!("Unknown log record type '{}'.", unexpected_record_type).into()),
  }
}

fn maybe_fix_mime_type_from_title(
  kvs: &mut Map<String, Value>,
  previous_title_maybe: Option<&str>,
  previous_mime_type_maybe: Option<&str>,
  stats: &mut MimeTypeMigrationStats,
  record_type: &str,
) -> InfuResult<()> {
  let item_id = json::get_string_field(kvs, "id")?.ok_or(format!("{} record does not have 'id' field.", record_type))?;
  let title_maybe = json::get_string_field(kvs, "title")?;
  let title = title_maybe.as_deref().or(previous_title_maybe);
  let derived_mime_type = match title.and_then(|title| mime_type_from_title_extension(title)) {
    Some(mime_type) => mime_type,
    None => return Ok(()),
  };
  let current_mime_type = json::get_string_field(kvs, "mimeType")?
    .or_else(|| previous_mime_type_maybe.map(|s| s.to_owned()))
    .map(|mime_type| normalized_mime_type(&mime_type));
  if let Some(current_mime_type) = current_mime_type.as_deref() {
    if current_mime_type.starts_with("image/") && derived_mime_type.starts_with("image/") {
      return Ok(());
    }
  }
  if current_mime_type.as_deref() != Some(derived_mime_type.as_str()) {
    kvs.insert("mimeType".to_owned(), Value::String(derived_mime_type.clone()));
    stats.record_change(&item_id, record_type, current_mime_type.as_deref(), &derived_mime_type);
  }
  Ok(())
}

fn mime_type_migration_state_from_entry(kvs: &Map<String, Value>, item_type: ItemType) -> InfuResult<MimeTypeMigrationState> {
  Ok(MimeTypeMigrationState {
    is_data_item: is_data_item_type(item_type),
    title: json::get_string_field(kvs, "title")?,
    mime_type: json::get_string_field(kvs, "mimeType")?.map(|mime_type| normalized_mime_type(&mime_type)),
  })
}

fn apply_mime_type_migration_update(
  previous_state: &MimeTypeMigrationState,
  kvs: &Map<String, Value>,
) -> InfuResult<MimeTypeMigrationState> {
  let mut next_state = previous_state.clone();
  if let Some(title) = json::get_string_field(kvs, "title")? {
    next_state.title = Some(title);
  }
  if let Some(mime_type) = json::get_string_field(kvs, "mimeType")? {
    next_state.mime_type = Some(normalized_mime_type(&mime_type));
  }
  Ok(next_state)
}

#[cfg(test)]
mod tests {
  use super::{
    MimeTypeMigrationStats, MimeTypeMigrationState, migrate_record_v27_to_v28, migrate_record_v28_to_v29,
  };
  use serde_json::{Map, Value};
  use std::collections::HashMap;

  #[test]
  fn migrates_mime_type_aliases_in_entry_records() {
    let mut entry = Map::new();
    entry.insert("__recordType".to_owned(), Value::String("entry".to_owned()));
    entry.insert("mimeType".to_owned(), Value::String("Image/JPG".to_owned()));

    let migrated = migrate_record_v27_to_v28(&entry).unwrap();
    assert_eq!(migrated.get("mimeType").unwrap().as_str().unwrap(), "image/jpeg");
  }

  #[test]
  fn migrates_invalid_mime_types_to_octet_stream() {
    let mut entry = Map::new();
    entry.insert("__recordType".to_owned(), Value::String("entry".to_owned()));
    entry.insert("mimeType".to_owned(), Value::String("not mime".to_owned()));

    let migrated = migrate_record_v27_to_v28(&entry).unwrap();
    assert_eq!(migrated.get("mimeType").unwrap().as_str().unwrap(), "application/octet-stream");
  }

  #[test]
  fn migrates_pdf_mime_type_from_entry_title() {
    let mut entry = Map::new();
    entry.insert("__recordType".to_owned(), Value::String("entry".to_owned()));
    entry.insert("id".to_owned(), Value::String("FILE1".to_owned()));
    entry.insert("itemType".to_owned(), Value::String("file".to_owned()));
    entry.insert("title".to_owned(), Value::String("Quarterly Report.pdf".to_owned()));
    entry.insert("mimeType".to_owned(), Value::String("application/octet-stream".to_owned()));

    let mut state_by_id = HashMap::new();
    let mut stats = MimeTypeMigrationStats::default();
    let migrated = migrate_record_v28_to_v29(&entry, &mut state_by_id, &mut stats).unwrap();

    assert_eq!(migrated.get("mimeType").unwrap().as_str().unwrap(), "application/pdf");
    assert_eq!(
      state_by_id.get("FILE1").unwrap().mime_type.as_deref().unwrap(),
      "application/pdf"
    );
    assert_eq!(
      stats.render_summary(),
      vec![
        "Scanned 1 item records.".to_owned(),
        "Changed MIME type on 1 records across 1 items.".to_owned(),
        "Changed entry records: 1. Changed update records: 0.".to_owned(),
        "application/octet-stream -> application/pdf: 1".to_owned(),
      ]
    );
  }

  #[test]
  fn migrates_title_only_update_to_include_matching_mime_type() {
    let mut update = Map::new();
    update.insert("__recordType".to_owned(), Value::String("update".to_owned()));
    update.insert("id".to_owned(), Value::String("FILE2".to_owned()));
    update.insert("title".to_owned(), Value::String("Renamed.pdf".to_owned()));

    let mut state_by_id = HashMap::new();
    state_by_id.insert(
      "FILE2".to_owned(),
      MimeTypeMigrationState {
        is_data_item: true,
        title: Some("Renamed.bin".to_owned()),
        mime_type: Some("application/octet-stream".to_owned()),
      },
    );
    let mut stats = MimeTypeMigrationStats::default();
    let migrated = migrate_record_v28_to_v29(&update, &mut state_by_id, &mut stats).unwrap();

    assert_eq!(migrated.get("mimeType").unwrap().as_str().unwrap(), "application/pdf");
    assert_eq!(state_by_id.get("FILE2").unwrap().title.as_deref().unwrap(), "Renamed.pdf");
    assert_eq!(
      state_by_id.get("FILE2").unwrap().mime_type.as_deref().unwrap(),
      "application/pdf"
    );
  }

  #[test]
  fn does_not_change_image_mime_type_when_title_implies_different_image_type() {
    let mut entry = Map::new();
    entry.insert("__recordType".to_owned(), Value::String("entry".to_owned()));
    entry.insert("id".to_owned(), Value::String("FILE3".to_owned()));
    entry.insert("itemType".to_owned(), Value::String("image".to_owned()));
    entry.insert("title".to_owned(), Value::String("Camera Upload.png".to_owned()));
    entry.insert("mimeType".to_owned(), Value::String("image/jpeg".to_owned()));

    let mut state_by_id = HashMap::new();
    let mut stats = MimeTypeMigrationStats::default();
    let migrated = migrate_record_v28_to_v29(&entry, &mut state_by_id, &mut stats).unwrap();

    assert_eq!(migrated.get("mimeType").unwrap().as_str().unwrap(), "image/jpeg");
    assert_eq!(
      state_by_id.get("FILE3").unwrap().mime_type.as_deref().unwrap(),
      "image/jpeg"
    );
    assert_eq!(
      stats.render_summary(),
      vec![
        "Scanned 1 item records.".to_owned(),
        "Changed MIME type on 0 records across 0 items.".to_owned(),
      ]
    );

    let mut entry = Map::new();
    entry.insert("__recordType".to_owned(), Value::String("entry".to_owned()));
    entry.insert("id".to_owned(), Value::String("FILE4".to_owned()));
    entry.insert("itemType".to_owned(), Value::String("image".to_owned()));
    entry.insert("title".to_owned(), Value::String("Thumbnail.jpg".to_owned()));
    entry.insert("mimeType".to_owned(), Value::String("image/webp".to_owned()));

    let mut state_by_id = HashMap::new();
    let mut stats = MimeTypeMigrationStats::default();
    let migrated = migrate_record_v28_to_v29(&entry, &mut state_by_id, &mut stats).unwrap();

    assert_eq!(migrated.get("mimeType").unwrap().as_str().unwrap(), "image/webp");
    assert_eq!(
      state_by_id.get("FILE4").unwrap().mime_type.as_deref().unwrap(),
      "image/webp"
    );
  }

  #[test]
  fn does_not_add_mime_type_to_note_entries() {
    let mut entry = Map::new();
    entry.insert("__recordType".to_owned(), Value::String("entry".to_owned()));
    entry.insert("id".to_owned(), Value::String("NOTE1".to_owned()));
    entry.insert("itemType".to_owned(), Value::String("note".to_owned()));
    entry.insert("title".to_owned(), Value::String("Meeting notes.pdf".to_owned()));

    let mut state_by_id = HashMap::new();
    let mut stats = MimeTypeMigrationStats::default();
    let migrated = migrate_record_v28_to_v29(&entry, &mut state_by_id, &mut stats).unwrap();

    assert!(migrated.get("mimeType").is_none());
    assert!(state_by_id.get("NOTE1").unwrap().mime_type.is_none());
    assert_eq!(
      stats.render_summary(),
      vec![
        "Scanned 1 item records.".to_owned(),
        "Changed MIME type on 0 records across 0 items.".to_owned(),
      ]
    );
  }
}

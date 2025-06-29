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

use infusdk::util::hash::combine_hashes;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::Uid;
use infusdk::item::{is_attachments_item_type, is_container_item_type};
use crate::storage::db::Db;
use tokio::sync::MutexGuard;


/// Creates a composite hash of an item and its attachments only.
/// Corresponds to GetItemsMode::ItemAndAttachmentsOnly.
pub fn hash_item_and_attachments_only(
    db: &MutexGuard<'_, Db>,
    item_id: &Uid,
) -> InfuResult<Uid> {
  let mut hashes = Vec::new();

  let item = db.item.get(item_id)?;
  hashes.push(item.hash());

  // Only check attachments if item type supports them
  if is_attachments_item_type(item.item_type) {
    let attachments = db.item.get_attachments(item_id)?;
    for attachment in attachments {
      hashes.push(attachment.hash());
    }
  }

  let hash_refs: Vec<&Uid> = hashes.iter().collect();
  Ok(combine_hashes(&hash_refs))
}

/// Creates a composite hash of all children of an item and their attachments only.
/// Does NOT include a hash of the item itself.
/// Corresponds to GetItemsMode::ChildrenAndTheirAttachmentsOnly.
pub fn hash_children_and_their_attachments_only(
    db: &MutexGuard<'_, Db>,
    item_id: &Uid,
) -> InfuResult<Uid> {
  let mut hashes = Vec::new();

  let item = db.item.get(item_id)?;

  // Only check children if item type is a container
  if is_container_item_type(item.item_type) {
    let children = db.item.get_children(item_id)?;
    for child in children {
      hashes.push(child.hash());

      // Only check child attachments if child type supports them
      if is_attachments_item_type(child.item_type) {
        let child_attachments = db.item.get_attachments(&child.id)?;
        for attachment in child_attachments {
          hashes.push(attachment.hash());
        }
      }
    }
  }

  let hash_refs: Vec<&Uid> = hashes.iter().collect();
  Ok(combine_hashes(&hash_refs))
}

/// Creates a composite hash of an item, its attachments, its children, and their attachments.
/// Corresponds to GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments.
pub fn hash_item_attachments_children_and_their_attachments(
    db: &MutexGuard<'_, Db>,
    item_id: &Uid,
) -> InfuResult<Uid> {
  let mut hashes = Vec::new();

  let item = db.item.get(item_id)?;
  hashes.push(item.hash());

  // Only check attachments if item type supports them
  if is_attachments_item_type(item.item_type) {
    let attachments = db.item.get_attachments(item_id)?;
    for attachment in attachments {
      hashes.push(attachment.hash());
    }
  }

  // Only check children if item type is a container
  if is_container_item_type(item.item_type) {
    let children = db.item.get_children(item_id)?;
    for child in children {
      hashes.push(child.hash());

      // Only check child attachments if child type supports them
      if is_attachments_item_type(child.item_type) {
        let child_attachments = db.item.get_attachments(&child.id)?;
        for attachment in child_attachments {
          hashes.push(attachment.hash());
        }
      }
    }
  }

  let hash_refs: Vec<&Uid> = hashes.iter().collect();
  Ok(combine_hashes(&hash_refs))
} 
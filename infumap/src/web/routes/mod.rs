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

use std::time::SystemTime;
use infusdk::{item::{AlignmentPoint, ArrangeAlgorithm, Item, ItemType, RelationshipToParent}, util::{geometry::{Vector, GRID_SIZE}, uid::Uid}};

pub mod account;
pub mod admin;
pub mod command;
pub mod files;



pub fn default_home_page(owner_id: &str, title: &str, home_page_id: Uid, inner_spatial_width_br: i64, natural_aspect: f64) -> Item {
  let inner_spatial_height_br: i64 = (inner_spatial_width_br as f64 / natural_aspect) as i64;
  Item {
    item_type: ItemType::Page,
    owner_id: String::from(owner_id),
    id: home_page_id,
    parent_id: None,
    relationship_to_parent: RelationshipToParent::NoParent,
    creation_date: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64,
    last_modified_date: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64,
    ordering: vec![128],
    order_children_by: Some(String::from("")),
    spatial_position_gr: Some(Vector { x: 0, y: 0 }),
    spatial_width_gr: Some(60 * GRID_SIZE),
    spatial_height_gr: None,
    title: Some(title.to_string()),
    original_creation_date: None,
    mime_type: None,
    file_size_bytes: None,
    flags: Some(0),
    permission_flags: Some(0),
    inner_spatial_width_gr: Some(inner_spatial_width_br * GRID_SIZE),
    natural_aspect: Some(natural_aspect),
    background_color_index: Some(0),
    arrange_algorithm: Some(ArrangeAlgorithm::SpatialStretch),
    popup_position_gr: Some(Vector { x: inner_spatial_width_br / 2 * GRID_SIZE, y: ((inner_spatial_height_br as f64 * 0.4) as i64) * GRID_SIZE }),
    popup_alignment_point: Some(AlignmentPoint::Center),
    popup_width_gr: Some(inner_spatial_width_br / 2 * GRID_SIZE),
    grid_number_of_columns: Some(4),
    grid_cell_aspect: Some(1.5),
    doc_width_bl: Some(36),
    justified_row_aspect: Some(6.0),
    url: None,
    format: None,
    table_columns: None,
    number_of_visible_columns: None,
    image_size_px: None,
    thumbnail: None,
    rating: None,
    link_to: None,
    text: None,
  }
}


pub fn default_trash_page(owner_id: &str, trash_page_id: Uid, natural_aspect: f64) -> Item {
  let inner_spatial_width_br: i64 = 60;
  let inner_spatial_height_br: i64 = (inner_spatial_width_br as f64 / natural_aspect) as i64;
  Item {
    item_type: ItemType::Page,
    owner_id: String::from(owner_id),
    id: trash_page_id,
    parent_id: None,
    relationship_to_parent: RelationshipToParent::NoParent,
    creation_date: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64,
    last_modified_date: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64,
    ordering: vec![128],
    order_children_by: Some(String::from("")),
    spatial_position_gr: Some(Vector { x: 0, y: 0 }),
    spatial_width_gr: Some(60 * GRID_SIZE),
    spatial_height_gr: None,
    title: Some("Trash".to_owned()),
    original_creation_date: None,
    mime_type: None,
    file_size_bytes: None,
    flags: Some(0),
    permission_flags: Some(0),
    inner_spatial_width_gr: Some(inner_spatial_width_br * GRID_SIZE),
    natural_aspect: Some(natural_aspect),
    background_color_index: Some(0),
    arrange_algorithm: Some(ArrangeAlgorithm::SpatialStretch),
    popup_position_gr: Some(Vector { x: inner_spatial_width_br / 2 * GRID_SIZE, y: ((inner_spatial_height_br as f64 * 0.4) as i64) * GRID_SIZE }),
    popup_alignment_point: Some(AlignmentPoint::Center),
    popup_width_gr: Some(inner_spatial_width_br / 2 * GRID_SIZE),
    grid_number_of_columns: Some(4),
    grid_cell_aspect: Some(1.5),
    doc_width_bl: Some(36),
    justified_row_aspect: Some(6.0),
    url: None,
    format: None,
    table_columns: None,
    number_of_visible_columns: None,
    image_size_px: None,
    thumbnail: None,
    rating: None,
    link_to: None,
    text: None,
  }
}


pub fn default_dock_page(owner_id: &str, dock_page_id: Uid, natural_aspect: f64) -> Item {
  let inner_spatial_width_br: i64 = 60;
  let inner_spatial_height_br: i64 = (inner_spatial_width_br as f64 / natural_aspect) as i64;
  Item {
    item_type: ItemType::Page,
    owner_id: String::from(owner_id),
    id: dock_page_id,
    parent_id: None,
    relationship_to_parent: RelationshipToParent::NoParent,
    creation_date: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64,
    last_modified_date: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64,
    ordering: vec![128],
    order_children_by: Some(String::from("")),
    spatial_position_gr: Some(Vector { x: 0, y: 0 }),
    spatial_width_gr: Some(60 * GRID_SIZE),
    spatial_height_gr: None,
    title: Some("Dock".to_owned()),
    original_creation_date: None,
    mime_type: None,
    file_size_bytes: None,
    flags: Some(0),
    permission_flags: Some(0),
    inner_spatial_width_gr: Some(inner_spatial_width_br * GRID_SIZE),
    natural_aspect: Some(natural_aspect),
    background_color_index: Some(0),
    arrange_algorithm: Some(ArrangeAlgorithm::SpatialStretch),
    popup_position_gr: Some(Vector { x: inner_spatial_width_br / 2 * GRID_SIZE, y: ((inner_spatial_height_br as f64 * 0.4) as i64) * GRID_SIZE }),
    popup_alignment_point: Some(AlignmentPoint::Center),
    popup_width_gr: Some(inner_spatial_width_br / 2 * GRID_SIZE),
    grid_number_of_columns: Some(1),
    grid_cell_aspect: Some(1.5),
    doc_width_bl: Some(36),
    justified_row_aspect: Some(6.0),
    url: None,
    format: None,
    table_columns: None,
    number_of_visible_columns: None,
    image_size_px: None,
    thumbnail: None,
    rating: None,
    link_to: None,
    text: None,
  }
}


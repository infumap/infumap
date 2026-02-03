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

use infusdk::{item::{ArrangeAlgorithm, Item, RelationshipToParent, TableColumn}, util::{geometry::{Vector, GRID_SIZE}, uid::Uid}};

pub mod account;
pub mod admin;
pub mod command;
pub mod files;



pub fn default_home_page(owner_id: &str, title: &str, home_page_id: Uid, inner_spatial_width_br: i64, natural_aspect: f64) -> Item {

  let mut item = Item::new_page(
    None,
    vec![128],
    Vector { x: 0, y: 0 },
    60 * GRID_SIZE,
    RelationshipToParent::NoParent,
    title,
    "",
    0,
    0,
    0,
    natural_aspect,
    inner_spatial_width_br * GRID_SIZE,
    ArrangeAlgorithm::SpatialStretch,
    4,
    1.5,
    36,
    7.0,
    1.0,
    vec![TableColumn { width_gr: 480, name: "Title".to_owned() }],
    1
  );

  item.owner_id = String::from(owner_id);
  item.id = home_page_id;

  item
}


pub fn default_trash_page(owner_id: &str, trash_page_id: Uid, natural_aspect: f64) -> Item {
  let inner_spatial_width_br: i64 = 60;

  let mut item = Item::new_page(
    None,
    vec![128],
    Vector { x: 0, y: 0 },
    inner_spatial_width_br * GRID_SIZE,
    RelationshipToParent::NoParent,
    "Trash",
    "",
    0,
    0,
    0,
    natural_aspect,
    inner_spatial_width_br * GRID_SIZE,
    ArrangeAlgorithm::SpatialStretch,
    4,
    1.5,
    36,
    7.0,
    1.0,
    vec![TableColumn { width_gr: 480, name: "Title".to_owned() }],
    1
  );

  item.owner_id = String::from(owner_id);
  item.id = trash_page_id;

  item
}


pub fn default_dock_page(owner_id: &str, dock_page_id: Uid, natural_aspect: f64) -> Item {
  let inner_spatial_width_br: i64 = 60;

  let mut item = Item::new_page(
    None,
    vec![128],
    Vector { x: 0, y: 0 },
    inner_spatial_width_br * GRID_SIZE,
    RelationshipToParent::NoParent,
    "Dock",
    "",
    0,
    0,
    0,
    natural_aspect,
    inner_spatial_width_br * GRID_SIZE,
    ArrangeAlgorithm::SpatialStretch,
    1,
    1.5,
    36,
    7.0,
    1.0,
    vec![TableColumn { width_gr: 480, name: "Title".to_owned() }],
    1
  );

  item.owner_id = String::from(owner_id);
  item.id = dock_page_id;

  item
}

use std::cmp::Ordering;
use std::sync::Arc;

use clap::{Arg, ArgMatches, Command};
use infusdk::item::{Item, ItemType, RelationshipToParent};
use infusdk::util::infu::InfuResult;
use log::info;
use tokio::sync::Mutex;

use crate::config::CONFIG_DATA_DIR;
use crate::rag::{FragmentSourceKind, build_fragments_for_item, clear_fragments_for_item};
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::util::ordering::compare_orderings;

pub fn make_clap_subcommand() -> Command {
  Command::new("fragments")
    .about("Build on-disk RAG fragment artifacts from item content without starting the web server.")
    .arg(
      Arg::new("settings_path")
        .short('s')
        .long("settings")
        .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
        .num_args(1)
        .required(false),
    )
    .arg(Arg::new("item_id").long("item-id").help("Build fragments only for this item.").num_args(1).required(false))
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let db = Arc::new(Mutex::new(Db::new(&data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?));

  {
    let mut db = db.lock().await;
    let all_user_ids: Vec<String> = db.user.all_user_ids().iter().map(|v| v.clone()).collect();
    for user_id in all_user_ids {
      db.item.load_user_items(&user_id, false).await?;
    }
  }

  let items: Vec<Item> = {
    let db = db.lock().await;
    if let Some(item_id) = sub_matches.get_one::<String>("item_id") {
      vec![db.item.get(item_id).map_err(|e| e.to_string())?.clone()]
    } else {
      let mut items = db
        .item
        .all_loaded_items()
        .into_iter()
        .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().map(Item::clone))
        .collect::<Vec<Item>>();
      items.sort_by(|a, b| a.owner_id.cmp(&b.owner_id).then(a.id.cmp(&b.id)));
      items
    }
  };

  let mut items_with_fragments = 0usize;
  let mut items_cleared = 0usize;
  let mut fragments_written = 0usize;

  for item in items {
    let fragment_source = {
      let db = db.lock().await;
      fragment_source_for_item(&db, &item)
    };
    let outcome = match fragment_source {
      Some(fragment_source) => {
        build_fragments_for_item(
          &data_dir,
          &item,
          fragment_source.source_kind,
          &fragment_source.source_text,
          fragment_source.container_title,
        )
        .await?
      }
      None => clear_fragments_for_item(&data_dir, &item).await?,
    };
    if outcome.wrote_fragments {
      items_with_fragments += 1;
      fragments_written += outcome.fragment_count;
    } else if outcome.cleared_existing_fragments {
      items_cleared += 1;
    }
  }

  info!(
    "Built RAG fragments for {} item(s), wrote {} fragment(s), cleared {} empty item artifact dir(s).",
    items_with_fragments, fragments_written, items_cleared
  );

  Ok(())
}

struct FragmentSource {
  source_kind: FragmentSourceKind,
  source_text: String,
  container_title: Option<String>,
}

fn fragment_source_for_item(db: &Db, item: &Item) -> Option<FragmentSource> {
  if item.item_type == ItemType::Link
    || item.item_type == ItemType::Rating
    || item.item_type == ItemType::Expression
    || item.item_type == ItemType::Password
    || item.item_type == ItemType::Page
    || item.item_type == ItemType::Table
  {
    return None;
  }
  if is_child_of_composite(db, item) {
    return None;
  }

  let container_title = container_title_for_item(db, item);
  if item.item_type == ItemType::Composite {
    let source_text = composite_child_titles(db, item)?;
    return Some(FragmentSource {
      source_kind: FragmentSourceKind::CompositeChildTitles,
      source_text,
      container_title,
    });
  }

  let source_text = item.title.as_deref().map(str::trim).filter(|title| !title.is_empty())?.to_owned();
  Some(FragmentSource { source_kind: FragmentSourceKind::ItemTitle, source_text, container_title })
}

fn is_child_of_composite(db: &Db, item: &Item) -> bool {
  if item.relationship_to_parent != RelationshipToParent::Child {
    return false;
  }
  let Some(parent_id) = item.parent_id.as_ref() else {
    return false;
  };
  db.item.get(parent_id).map(|parent| parent.item_type == ItemType::Composite).unwrap_or(false)
}

fn composite_child_titles(db: &Db, item: &Item) -> Option<String> {
  let mut children = db.item.get_children(&item.id).ok()?;
  children.sort_by(|a, b| match compare_orderings(&a.ordering, &b.ordering) {
    -1 => Ordering::Less,
    1 => Ordering::Greater,
    _ => Ordering::Equal,
  });

  let child_titles = children
    .into_iter()
    .filter_map(|child| child.title.as_deref().map(str::trim).filter(|title| !title.is_empty()).map(str::to_owned))
    .collect::<Vec<String>>();
  if child_titles.is_empty() {
    return None;
  }
  Some(child_titles.join("\n"))
}

fn container_title_for_item(db: &Db, item: &Item) -> Option<String> {
  match item.relationship_to_parent {
    RelationshipToParent::Child => {
      let parent_id = item.parent_id.as_ref()?;
      let user = db.user.get(&item.owner_id)?;
      if parent_id == &user.home_page_id || parent_id == &user.trash_page_id || parent_id == &user.dock_page_id {
        return None;
      }
      let parent = db.item.get(parent_id).ok()?;
      parent.title.as_deref().map(|title| title.trim()).filter(|title| !title.is_empty()).map(|title| title.to_owned())
    }
    RelationshipToParent::Attachment => {
      // TODO: Decide whether attachment fragments should include parent title
      // or attachment-specific context. Leave them untouched for now.
      None
    }
    RelationshipToParent::NoParent => None,
  }
}

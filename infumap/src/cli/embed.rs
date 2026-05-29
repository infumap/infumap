use clap::{Arg, ArgAction, ArgMatches, Command};
use infusdk::util::infu::InfuResult;

use super::build_http_client;
use crate::ai::indexing::rebuild_all_fragment_indexes;
use crate::ai::text_embedding::resolve_text_embedding_service_url;
use crate::config::CONFIG_DATA_DIR;
use crate::setup::get_config;

pub fn make_clap_subcommand() -> Command {
  Command::new("embed")
    .about("Rebuild per-user fragment search indexes from existing fragment artifacts.")
    .arg(settings_arg())
    .arg(
      Arg::new("service_url")
        .long("service-url")
        .help("Text embedding endpoint URL, for example http://127.0.0.1:8787/text-embed. Falls back to the text_embed endpoint discovered from gpu_tools_url in settings.toml.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("continue")
        .long("continue")
        .help("Continue a previous rebuild by resuming fragments already written to fragments.sqlite3.tmp.")
        .action(ArgAction::SetTrue),
    )
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let embed_url = resolve_text_embedding_service_url(
    &config,
    sub_matches.get_one::<String>("service_url").map(String::as_str),
    "--service-url",
  )
  .await?;
  let continue_rebuild = sub_matches.get_flag("continue");

  let client = build_http_client(None).await?;
  let summary = rebuild_all_fragment_indexes(&data_dir, Some(&client), Some(&embed_url), continue_rebuild).await?;

  println!(
    "Processed {} user(s): rebuilt {}, skipped current {}, embedded {} vector fragment(s), indexed {} lexical fragment(s), reused {} fragment(s) from temp DB, removed {} stale empty index file(s).",
    summary.users_seen,
    summary.users_rebuilt,
    summary.users_skipped_current,
    summary.fragments_embedded,
    summary.lexical_fragments_indexed,
    summary.fragments_reused,
    summary.empty_index_files_removed
  );

  Ok(())
}

fn settings_arg() -> Arg {
  Arg::new("settings_path")
    .short('s')
    .long("settings")
    .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
    .num_args(1)
    .required(false)
}

// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Local settings editor shared by the native UI and server configuration validation.
//! Requests include credentials and must never be logged or exposed as a web API.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::net::IpAddr;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::time::Duration;

use config::{Config, FileFormat};
use infusdk::util::infu::InfuResult;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use toml_edit::{Array, ArrayOfTables, DocumentMut, InlineTable, Item, Table, Value, value};

use crate::ai::artifact_io::sha256;
use crate::config::*;
use crate::setup::config_from_settings_text;
use crate::util::fs::expand_tilde;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct ProviderSettings {
  id: String,
  url: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  api_key: Option<String>,
  #[serde(default = "default_adapter")]
  adapter: String,
  #[serde(default = "default_discovery")]
  discover_models: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  model_name: Option<String>,
  #[serde(default)]
  reasoning_efforts: Vec<String>,
}

fn default_adapter() -> String {
  "openai".to_owned()
}
fn default_discovery() -> bool {
  true
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum Request {
  Load,
  Save { revision: String, address: String, port: String, providers: Vec<ProviderSettings> },
  Check { provider: ProviderSettings },
}

struct SettingsFile {
  path: PathBuf,
  original: Option<String>,
  document: DocumentMut,
  environment: Config,
  env_only: bool,
}

fn parse_document(text: &str) -> InfuResult<DocumentMut> {
  // Parser errors can quote lines containing credentials. Keep those out of diagnostics.
  text.parse().map_err(|_| "Settings file is not valid TOML. Correct its syntax and reload Settings.".into())
}

fn file_config(text: &str) -> InfuResult<Config> {
  Config::builder()
    .add_source(config::File::from_str(text, FileFormat::Toml))
    .build()
    .map_err(|_| "Could not read settings values.".into())
}

impl SettingsFile {
  fn load(settings: Option<&str>) -> InfuResult<Self> {
    let environment = Config::builder()
      .add_source(config::Environment::with_prefix(ENV_CONFIG_PREFIX))
      .build()
      .map_err(|_| "Could not read environment settings.")?;
    let env_only = settings.is_none() && environment.get_bool(CONFIG_ENV_ONLY).unwrap_or(false);
    let mut path = match settings {
      Some(path) => expand_tilde(path).ok_or("Could not expand the settings path.")?,
      None => dirs::home_dir().ok_or("Could not locate the home directory.")?.join(".infumap/settings.toml"),
    };
    if path.is_dir() {
      path.push("settings.toml");
    }
    // Replace the destination of a symlink, preserving the symlink itself.
    if path.exists() {
      path = path.canonicalize()?;
    } else if !path.is_absolute() {
      path = std::env::current_dir()?.join(path);
    }
    let original = if env_only {
      None
    } else {
      match fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == ErrorKind::NotFound && settings.is_none() => None,
        Err(error) => return Err(format!("Could not read '{}': {}", path.display(), error).into()),
      }
    };
    let text = original.clone().unwrap_or_else(|| {
      include_str!("../default_settings.toml").replace("{{encryption_key}}", &crate::util::crypto::generate_key())
    });
    Ok(Self { path, original, document: parse_document(&text)?, environment, env_only })
  }

  fn overridden(&self, key: &str) -> bool {
    self.env_only || self.environment.get::<config::Value>(key).is_ok()
  }

  fn revision(&self) -> String {
    self.original.as_ref().map_or_else(|| "missing".to_owned(), |text| sha256(text.as_bytes()))
  }

  fn snapshot(&self) -> InfuResult<Json> {
    let config = Config::builder()
      .add_source(config::File::from_str(&self.document.to_string(), FileFormat::Toml))
      .add_source(self.environment.clone())
      .build()
      .map_err(|_| "Could not read settings values.")?;
    let providers = read_providers(&config)?;
    Ok(json!({
      "path": self.path, "revision": self.revision(), "env_only": self.env_only,
      "address": config.get_string(CONFIG_ADDRESS).unwrap_or_else(|_| CONFIG_ADDRESS_DEFAULT.to_owned()),
      "port": config.get_string(CONFIG_PORT).unwrap_or_else(|_| CONFIG_PORT_DEFAULT.to_owned()),
      "providers": providers,
      "address_overridden": self.overridden(CONFIG_ADDRESS),
      "port_overridden": self.overridden(CONFIG_PORT),
      "providers_overridden": self.overridden(CONFIG_CHAT_PROVIDERS),
    }))
  }
}

fn read_providers(config: &Config) -> InfuResult<Vec<ProviderSettings>> {
  match config.get::<Vec<ProviderSettings>>(CONFIG_CHAT_PROVIDERS) {
    Ok(providers) => Ok(providers),
    Err(_) => match config.get_string(CONFIG_CHAT_PROVIDERS) {
      Ok(raw) if raw.trim().is_empty() => Ok(Vec::new()),
      Ok(raw) => serde_json::from_str(&raw).map_err(|_| "Could not read chat provider settings.".into()),
      Err(config::ConfigError::NotFound(_)) => Ok(Vec::new()),
      Err(_) => Err("Chat providers must be an array or JSON string.".into()),
    },
  }
}

fn replace_value(existing: &mut Value, mut replacement: Value) {
  if existing.to_string() == replacement.to_string() {
    return;
  }
  *replacement.decor_mut() = existing.decor().clone();
  *existing = replacement;
}

fn set_item(table: &mut Table, key: &str, replacement: Value) {
  if let Some(existing) = table.get_mut(key).and_then(Item::as_value_mut) {
    replace_value(existing, replacement);
  } else {
    table.insert(key, Item::Value(replacement));
  }
}

fn provider_fields(provider: &ProviderSettings) -> Vec<(&'static str, Option<Value>)> {
  let mut efforts = Array::new();
  for effort in &provider.reasoning_efforts {
    efforts.push(effort.as_str());
  }
  vec![
    ("id", Some(provider.id.as_str().into())),
    ("url", Some(provider.url.as_str().into())),
    ("adapter", Some(provider.adapter.as_str().into())),
    ("api_key", provider.api_key.as_ref().filter(|key| !key.is_empty()).map(|key| key.as_str().into())),
    ("discover_models", Some(provider.discover_models.into())),
    (
      "model_name",
      if provider.discover_models {
        None
      } else {
        provider.model_name.as_ref().filter(|name| !name.is_empty()).map(|name| name.as_str().into())
      },
    ),
    ("reasoning_efforts", if provider.reasoning_efforts.is_empty() { None } else { Some(efforts.into()) }),
  ]
}

fn update_providers(document: &mut DocumentMut, providers: &[ProviderSettings]) -> InfuResult<()> {
  let current = read_providers(&file_config(&document.to_string())?)?;
  if current == providers {
    return Ok(());
  }
  let by_id: HashMap<_, _> = current.iter().map(|provider| (provider.id.as_str(), provider)).collect();
  // Retain table/array layout and field decorations so editing a key does not
  // rewrite hand-authored comments or unrelated server settings.
  if let Some(tables) = document.get(CONFIG_CHAT_PROVIDERS).and_then(Item::as_array_of_tables) {
    let existing: HashMap<_, _> =
      tables.iter().filter_map(|table| Some((table.get("id")?.as_str()?.to_owned(), table.clone()))).collect();
    let mut updated = ArrayOfTables::new();
    for provider in providers {
      let mut table = existing.get(&provider.id).cloned().unwrap_or_default();
      if by_id.get(provider.id.as_str()).copied() != Some(provider) {
        for (key, field) in provider_fields(provider) {
          match field {
            Some(field) => set_item(&mut table, key, field),
            None => {
              table.remove(key);
            }
          }
        }
      }
      updated.push(table);
    }
    document[CONFIG_CHAT_PROVIDERS] = Item::ArrayOfTables(updated);
  } else if let Some(array) = document.get_mut(CONFIG_CHAT_PROVIDERS).and_then(Item::as_array_mut) {
    let existing: HashMap<_, _> = array
      .iter()
      .filter_map(|entry| {
        let table = entry.as_inline_table()?;
        Some((table.get("id")?.as_str()?.to_owned(), entry.clone()))
      })
      .collect();
    let mut updated = array.clone();
    updated.clear();
    for provider in providers {
      let mut entry = existing.get(&provider.id).cloned().unwrap_or_else(|| Value::InlineTable(InlineTable::new()));
      let table = entry.as_inline_table_mut().ok_or("Expected a provider table.")?;
      if by_id.get(provider.id.as_str()).copied() != Some(provider) {
        for (key, field) in provider_fields(provider) {
          match field {
            Some(field) => match table.get_mut(key) {
              Some(existing) => replace_value(existing, field),
              None => {
                table.insert(key, field);
              }
            },
            None => {
              table.remove(key);
            }
          }
        }
      }
      updated.push_formatted(entry);
    }
    *array = updated;
  } else if document.get(CONFIG_CHAT_PROVIDERS).and_then(Item::as_str).is_some() {
    set_item(document.as_table_mut(), CONFIG_CHAT_PROVIDERS, serde_json::to_string(providers)?.into());
  } else {
    let mut tables = ArrayOfTables::new();
    for provider in providers {
      let mut table = Table::new();
      for (key, field) in provider_fields(provider) {
        if let Some(field) = field {
          table.insert(key, Item::Value(field));
        }
      }
      tables.push(table);
    }
    if providers.is_empty() {
      document[CONFIG_CHAT_PROVIDERS] = value(Array::new());
    } else {
      document[CONFIG_CHAT_PROVIDERS] = Item::ArrayOfTables(tables);
    }
  }
  Ok(())
}

fn validate_providers(providers: &[ProviderSettings]) -> InfuResult<()> {
  let mut ids = HashSet::new();
  for provider in providers {
    if !ids.insert(provider.id.trim()) {
      return Err(format!("Provider ID '{}' is used more than once.", provider.id).into());
    }
  }
  let text = provider_document(providers)?.to_string();
  config_from_settings_text(&text, false)?;
  Ok(())
}

fn provider_document(providers: &[ProviderSettings]) -> InfuResult<DocumentMut> {
  let mut document = DocumentMut::new();
  update_providers(&mut document, providers)?;
  Ok(document)
}

fn save(
  settings: Option<&str>,
  revision: &str,
  address: &str,
  port: &str,
  providers: &[ProviderSettings],
) -> InfuResult<Json> {
  let mut file = SettingsFile::load(settings)?;
  if file.env_only {
    return Err("Settings are supplied entirely by environment variables.".into());
  }
  let parent = file.path.parent().ok_or("Settings path has no parent directory.")?;
  fs::DirBuilder::new().recursive(true).mode(0o700).create(parent)?;
  let lock = OpenOptions::new()
    .create(true)
    .truncate(false)
    .write(true)
    .mode(0o600)
    .open(parent.join(".infumap-settings.lock"))?;
  lock.try_lock().map_err(|_| "Settings are being saved by another process. Try again.")?;
  if file.revision() != revision {
    return Err("Settings changed on disk. Reload before saving to avoid overwriting those changes.".into());
  }

  if !file.overridden(CONFIG_ADDRESS) {
    let ip: IpAddr = address
      .trim()
      .trim_start_matches('[')
      .trim_end_matches(']')
      .parse()
      .map_err(|_| "Listen address must be an IPv4 or IPv6 address.")?;
    let address = match ip {
      IpAddr::V4(ip) => ip.to_string(),
      IpAddr::V6(ip) => format!("[{ip}]"),
    };
    set_item(file.document.as_table_mut(), CONFIG_ADDRESS, address.into());
  }
  if !file.overridden(CONFIG_PORT) {
    let port = port.trim().parse::<u16>().map_err(|_| "Port must be an integer from 0 to 65535.")?;
    set_item(file.document.as_table_mut(), CONFIG_PORT, i64::from(port).into());
  }
  if !file.overridden(CONFIG_CHAT_PROVIDERS) {
    validate_providers(providers)?;
    update_providers(&mut file.document, providers)?;
  }
  let text = file.document.to_string();
  config_from_settings_text(&text, true)?;
  let temporary = parent.join(format!(".settings-{}.tmp", uuid::Uuid::new_v4()));
  let result = (|| -> InfuResult<()> {
    let mut output = OpenOptions::new().create_new(true).write(true).mode(0o600).open(&temporary)?;
    output.write_all(text.as_bytes())?;
    if file.original.is_some() {
      let permissions = fs::metadata(&file.path)?.permissions();
      if permissions.readonly() {
        return Err("Settings file is read-only.".into());
      }
      output.set_permissions(fs::Permissions::from_mode(permissions.mode() & 0o600))?;
    }
    output.sync_all()?;
    drop(output);
    // Check again immediately before replacement, including first-run creation
    // by the server while the settings window was open.
    let latest = match fs::read_to_string(&file.path) {
      Ok(text) => Some(text),
      Err(error) if error.kind() == ErrorKind::NotFound => None,
      Err(error) => return Err(error.into()),
    };
    if latest != file.original {
      return Err("Settings changed on disk. Reload before saving.".into());
    }
    fs::rename(&temporary, &file.path)?;
    match File::open(parent)?.sync_all() {
      Ok(()) => {}
      Err(error) if matches!(error.kind(), ErrorKind::Unsupported | ErrorKind::InvalidInput) => {}
      Err(error) => return Err(error.into()),
    }
    Ok(())
  })();
  if result.is_err() {
    let _ = fs::remove_file(&temporary);
  }
  result?;
  file.original = Some(text);
  file.snapshot()
}

async fn check_provider(provider: ProviderSettings) -> InfuResult<Json> {
  validate_providers(std::slice::from_ref(&provider))?;
  let config = config_from_settings_text(&provider_document(std::slice::from_ref(&provider))?.to_string(), false)?;
  let parsed = crate::web::routes::command::chat_providers_from_config(&config)?.remove(0);
  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(10))
    .timeout(Duration::from_secs(45))
    .redirect(reqwest::redirect::Policy::none())
    .build()
    .map_err(|_| "Could not create the connection checker.")?;
  let mut request = if provider.discover_models {
    client.get(parsed.api_url("models")?)
  } else {
    // Only a fixed synthetic prompt is sent; no account data or chat history.
    client.post(parsed.api_url("chat/completions")?).json(&json!({
      "model": parsed.model_name, "messages": [{"role":"user", "content":"Reply only with OK."}], "stream":false,
    }))
  };
  if let Some(key) = parsed.api_key {
    request = request.bearer_auth(key);
  }
  let response = request
    .send()
    .await
    .map_err(|_| "Could not connect to the provider within 45 seconds. Check its URL and network access.")?;
  if !response.status().is_success() {
    return Err(
      format!(
        "Provider returned HTTP {}. Check the endpoint, credentials and model. No settings were changed.",
        response.status()
      )
      .into(),
    );
  }
  let response: Json = response.json().await.map_err(|_| "Provider returned an invalid JSON response.")?;
  if provider.discover_models {
    let models = response.get("data").and_then(Json::as_array).ok_or("Provider did not return a model list.")?;
    let ids: Vec<_> = models.iter().filter_map(|model| model.get("id").and_then(Json::as_str)).collect();
    Ok(
      json!({"message": format!("Model endpoint reached: {} model(s). Chat access and credentials have not been verified.", ids.len()), "models": ids}),
    )
  } else {
    let has_message = response
      .get("choices")
      .and_then(Json::as_array)
      .is_some_and(|choices| choices.iter().any(|choice| choice.get("message").and_then(Json::as_object).is_some()));
    if response.get("error").is_some_and(|error| !error.is_null()) || !has_message {
      return Err("Provider did not return a successful chat response.".into());
    }
    Ok(json!({"message":"Chat request succeeded with the configured model."}))
  }
}

/// Called only by the local native UI. The returned JSON may contain API keys.
pub fn request(settings: Option<&str>, request: &str) -> String {
  let result: InfuResult<Json> = (|| {
    let request: Request = serde_json::from_str(request).map_err(|_| "Invalid settings request.")?;
    match request {
      Request::Load => SettingsFile::load(settings)?.snapshot(),
      Request::Save { revision, address, port, providers } => save(settings, &revision, &address, &port, &providers),
      Request::Check { provider } => tokio::runtime::Runtime::new()?.block_on(check_provider(provider)),
    }
  })();
  match result {
    Ok(value) => json!({"ok":true,"value":value}),
    Err(error) => json!({"ok":false,"error":error.to_string()}),
  }
  .to_string()
}

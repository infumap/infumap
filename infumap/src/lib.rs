// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

mod ai;
pub mod cli;
mod config;
mod logging;
mod query_configuration;
pub mod setup;
mod storage;
mod tokiort;
mod util;
pub mod web;

pub use logging::init_logger;

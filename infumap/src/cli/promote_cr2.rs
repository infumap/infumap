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

use clap::{ArgMatches, Command};
use infusdk::util::infu::InfuResult;

use super::promote_image::{self, PromotionFormat};

pub fn make_clap_subcommand() -> Command {
  promote_image::make_clap_subcommand(PromotionFormat::Cr2)
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  promote_image::execute(sub_matches, PromotionFormat::Cr2).await
}

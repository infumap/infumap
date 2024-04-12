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

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::num::{TryFromIntError, ParseIntError};
use std::string::FromUtf8Error;
use std::time::SystemTimeError;


pub type InfuResult<T> = Result<T, InfuError>;


#[derive(Debug)]
pub struct InfuError {
  message: String
}

impl InfuError {
  pub fn new(message: &str) -> InfuError {
    InfuError { message: message.to_string() }
  }
}

impl Display for InfuError {
  fn fmt(&self, f: &mut Formatter<'_>) -> Result<(), std::fmt::Error> {
    write!(f, "{}", self.message)
  }
}

impl Error for InfuError {
  fn source(&self) -> Option<&(dyn Error + 'static)> {
    None
  }
}


impl From<serde_json::Error> for InfuError {
  fn from(err: serde_json::Error) -> Self { Self::new(&err.to_string()) }
}

impl From<std::io::Error> for InfuError {
  fn from(err: std::io::Error) -> Self { Self::new(&err.to_string()) }
}

impl From<SystemTimeError> for InfuError {
  fn from(err: SystemTimeError) -> Self { Self::new(&err.to_string()) }
}

impl From<String> for InfuError {
  fn from(err: String) -> Self { Self::new(&err) }
}

impl From<&str> for InfuError {
  fn from(err: &str) -> Self { Self::new(&err) }
}

impl From<TryFromIntError> for InfuError {
  fn from(err: TryFromIntError) -> Self { Self::new(&err.to_string()) }
}

impl From<ParseIntError> for InfuError {
  fn from(err: ParseIntError) -> Self { Self::new(&err.to_string()) }
}

impl From<FromUtf8Error> for InfuError {
  fn from(err: FromUtf8Error) -> Self { Self::new(&err.to_string()) }
}

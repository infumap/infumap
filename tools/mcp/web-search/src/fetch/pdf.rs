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

use crate::error::InfuResult;

use super::http::{DownloadedDocument, is_pdf};

/// PDFs are never decoded as text or sent to an OCR-capable fallback.
/// GPU discovery and native-only uploads are implemented in plan step 7.
pub(super) fn extract_native(document: &DownloadedDocument) -> InfuResult<String> {
  if !is_pdf(&document.body) {
    return Err("The response claims to be a PDF but has no PDF signature.".into());
  }
  Err("PDF detected. Native-only PDF extraction is not yet connected to web_fetch.".into())
}

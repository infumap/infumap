# Copyright (C) The Infumap Authors
# This file is part of Infumap.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

from __future__ import annotations

from pydantic import BaseModel, Field


class ImageTagResponse(BaseModel):
    detailed_caption: str | None = None
    tags: list[str] = Field(default_factory=list)
    key_objects: list[str] = Field(default_factory=list)
    ocr_text: list[str] = Field(default_factory=list)
    scene: str | None = None
    location_type: str | None = None
    activities: list[str] = Field(default_factory=list)
    document_confidence: float = 0.0
    document_reasons: str | None = None

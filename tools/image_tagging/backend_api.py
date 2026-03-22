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
    scene: str | None = None
    document_confidence: float = 0.0
    face_recognition_candidate_confidence: float = 0.0
    visible_face_count_estimate: str | None = None
    tags: list[str] = Field(default_factory=list)
    ocr_text: list[str] = Field(default_factory=list)

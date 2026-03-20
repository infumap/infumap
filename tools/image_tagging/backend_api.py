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

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field


@dataclass
class BackendConfig:
    backend_spec: str
    model_id: str
    device: str
    dtype: Any
    max_concurrency: int


class ImageInfo(BaseModel):
    width: int
    height: int
    mime_type: str | None


class DetectedObject(BaseModel):
    label: str
    bbox: list[float] = Field(default_factory=list)


class OCRRegion(BaseModel):
    text: str
    quad_box: list[float] = Field(default_factory=list)


class DocumentCandidateInfo(BaseModel):
    heuristic_version: str
    is_document_candidate: bool
    triggered_rules: list[str]
    text_region_count: int
    text_char_count: int
    text_word_count: int
    text_coverage_ratio: float


class ImageTagResponse(BaseModel):
    success: bool
    file_name: str
    backend: str
    model_id: str
    image: ImageInfo
    detailed_caption: str | None = None
    tags: list[str] = Field(default_factory=list)
    objects: list[DetectedObject] = Field(default_factory=list)
    ocr_text: str = ""
    ocr_regions: list[OCRRegion] = Field(default_factory=list)
    document_candidate: DocumentCandidateInfo | None = None
    raw_task_outputs: dict[str, Any] = Field(default_factory=dict)
    task_durations_ms: dict[str, int] = Field(default_factory=dict)
    backend_payload: dict[str, Any] = Field(default_factory=dict)
    duration_ms: int


class ImageTaggingBackend(ABC):
    def __init__(self, config: BackendConfig):
        self.config = config

    @property
    @abstractmethod
    def name(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def startup(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def shutdown(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def tag_image_file(self, file_path: str, file_name: str, upload_mime_type: str | None) -> ImageTagResponse:
        raise NotImplementedError

    def health_ready(self) -> bool:
        return True

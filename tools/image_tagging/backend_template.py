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

from pathlib import Path

from backend_api import BackendConfig, DocumentCandidateInfo, ImageInfo, ImageTagResponse, ImageTaggingBackend

PIP_REQUIREMENTS: list[str] = []


class Backend(ImageTaggingBackend):
    @property
    def name(self) -> str:
        return "custom-template"

    def startup(self) -> None:
        # Load your model here once at process startup.
        # Keep optional heavy imports inside this method so run.sh can inspect
        # PIP_REQUIREMENTS without importing model-specific dependencies first.
        pass

    def shutdown(self) -> None:
        # Release GPU / model resources here if needed.
        pass

    def health_ready(self) -> bool:
        return True

    def tag_image_file(self, file_path: str, file_name: str, upload_mime_type: str | None) -> ImageTagResponse:
        # Replace this stub with your model call. You have access to:
        # - self.config.model_id
        # - self.config.device
        # - self.config.dtype
        # - self.config.max_concurrency
        # The service expects one ImageTagResponse per image.
        image_path = Path(file_path)
        return ImageTagResponse(
            success=True,
            file_name=file_name,
            backend=self.name,
            model_id=self.config.model_id,
            image=ImageInfo(width=0, height=0, mime_type=upload_mime_type),
            detailed_caption=f"Replace backend_template.py with a real backend for {image_path.name}.",
            tags=[],
            ocr_text="",
            document_candidate=DocumentCandidateInfo(
                heuristic_version="custom-template-v1",
                is_document_candidate=False,
                triggered_rules=[],
                text_region_count=0,
                text_char_count=0,
                text_word_count=0,
                text_coverage_ratio=0.0,
            ),
            duration_ms=0,
            backend_payload={"note": "template backend"},
        )

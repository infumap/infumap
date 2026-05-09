/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import type { SearchPathElement, SearchResult, SearchSemanticMatch } from "../server";
import type { ItemPathSegment } from "./item-path";
import { EMPTY_UID, Uid } from "./uid";


export interface CatalogSemanticMatchDisplay {
  text: string,
  href: string,
  pageLabel: string | null,
  scoreLabel: string | null,
}

export interface CatalogSearchResultDisplay {
  pathSegments: Array<ItemPathSegment>,
  semanticMatch: CatalogSemanticMatchDisplay | null,
  semanticMatches: Array<CatalogSemanticMatchDisplay>,
}

function fallbackPathTitle(itemType: string): string {
  return `[${itemType}]`;
}

export function searchResultPathSegmentsFromPath(path: Array<SearchPathElement>): Array<ItemPathSegment> {
  return path.map(segment => ({
    id: segment.id,
    itemType: segment.itemType,
    title: segment.title ?? fallbackPathTitle(segment.itemType),
  }));
}

export function searchResultPathSegments(result: SearchResult): Array<ItemPathSegment> {
  return searchResultPathSegmentsFromPath(result.path);
}

export function searchResultTargetId(result: SearchResult): Uid | null {
  const targetId = result.path[result.path.length - 1]?.id;
  if (!targetId || targetId == EMPTY_UID) {
    return null;
  }
  return targetId;
}

export function semanticMatchPageLabel(pageStart?: number, pageEnd?: number): string | null {
  if (pageStart == null || pageEnd == null) {
    return null;
  }
  return pageStart == pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}-${pageEnd}`;
}

export function formatCatalogSemanticMatchText(_sourceKind: string, text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatSearchScoreValue(score?: number): string | null {
  if (typeof score != "number" || !Number.isFinite(score)) {
    return null;
  }

  const clamped = Math.max(0.1, Math.min(99.9, score * 100));
  return clamped.toFixed(1).padStart(4, "0");
}

export function formatSearchFragmentScore(score?: number): string | null {
  const scoreValue = formatSearchScoreValue(score);
  return scoreValue == null ? null : `(score: ${scoreValue})`;
}

function appendTruncationEllipsis(text: string): string {
  return `${text.replace(/(?:\s*\.)+$/, "")}...`;
}

export function catalogSemanticMatchDisplayFromMatch(
  targetId: Uid | null | undefined,
  match: SearchSemanticMatch | null | undefined,
): CatalogSemanticMatchDisplay | null {
  if (!targetId || targetId == EMPTY_UID || !match) {
    return null;
  }

  const formattedText = formatCatalogSemanticMatchText(match.sourceKind, match.text);
  if (formattedText.trim() == "") {
    return null;
  }

  return {
    text: match.textTruncated ? appendTruncationEllipsis(formattedText) : formattedText,
    href: `/files/${targetId}/fragments/${match.fragmentOrdinal}`,
    pageLabel: semanticMatchPageLabel(match.pageStart, match.pageEnd),
    scoreLabel: formatSearchFragmentScore(match.score),
  };
}

export function catalogSearchResultDisplay(result: SearchResult): CatalogSearchResultDisplay {
  const targetId = searchResultTargetId(result);
  const semanticMatches = [
    result.semanticMatch,
    ...(result.additionalSemanticMatches ?? []),
  ]
    .map(match => catalogSemanticMatchDisplayFromMatch(targetId, match))
    .filter((match): match is CatalogSemanticMatchDisplay => match != null);

  return {
    pathSegments: searchResultPathSegments(result),
    semanticMatch: semanticMatches[0] ?? null,
    semanticMatches,
  };
}

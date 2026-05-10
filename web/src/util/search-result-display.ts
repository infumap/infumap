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

import type { SearchPathElement, SearchResult, SearchFragmentMatch } from "../server";
import type { ItemPathSegment } from "./item-path";
import { EMPTY_UID, Uid } from "./uid";

const ITEM_TITLE_SOURCE_KIND = "item_title";

export interface CatalogFragmentMatchDisplay {
  text: string,
  href: string | null,
  pageLabel: string | null,
  scoreLabel: string | null,
}

export interface CatalogSearchResultDisplay {
  pathSegments: Array<ItemPathSegment>,
  fragmentMatch: CatalogFragmentMatchDisplay | null,
  fragmentMatches: Array<CatalogFragmentMatchDisplay>,
  overallScoreLabel: string | null,
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

export function fragmentMatchPageLabel(pageStart?: number, pageEnd?: number): string | null {
  if (pageStart == null || pageEnd == null) {
    return null;
  }
  return pageStart == pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}-${pageEnd}`;
}

export function formatCatalogFragmentMatchText(_sourceKind: string, text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatSearchScoreValue(score?: number): string | null {
  if (typeof score != "number" || !Number.isFinite(score)) {
    return null;
  }

  const clamped = Math.max(0.1, Math.min(99.9, score * 100));
  return clamped.toFixed(1).padStart(4, "0");
}

export function formatSearchOverallScore(score?: number): string | null {
  const scoreValue = formatSearchScoreValue(score);
  return scoreValue == null ? null : `Overall: ${scoreValue}`;
}

function formatRawSearchScoreValue(score?: number): string | null {
  if (typeof score != "number" || !Number.isFinite(score)) {
    return null;
  }
  return score.toFixed(3);
}

export function formatSearchEvidenceScore(match: SearchFragmentMatch): string | null {
  const lexicalScore = formatRawSearchScoreValue(match.lexicalScore);
  if (lexicalScore != null) {
    return `(lexical: ${lexicalScore})`;
  }

  const semanticDistance = formatRawSearchScoreValue(match.semanticDistance);
  if (semanticDistance != null) {
    return `(semantic: ${semanticDistance})`;
  }

  return null;
}

function appendTruncationEllipsis(text: string): string {
  return `${text.replace(/(?:\s*\.)+$/, "")}...`;
}

export function catalogFragmentMatchDisplayFromMatch(
  targetId: Uid | null | undefined,
  match: SearchFragmentMatch | null | undefined,
): CatalogFragmentMatchDisplay | null {
  if (!targetId || targetId == EMPTY_UID || !match) {
    return null;
  }

  const formattedText = formatCatalogFragmentMatchText(match.sourceKind, match.text);
  if (formattedText.trim() == "") {
    return null;
  }

  return {
    text: match.textTruncated ? appendTruncationEllipsis(formattedText) : formattedText,
    href: match.sourceKind == ITEM_TITLE_SOURCE_KIND ? null : `/files/${targetId}/fragments/${match.fragmentOrdinal}`,
    pageLabel: fragmentMatchPageLabel(match.pageStart, match.pageEnd),
    scoreLabel: formatSearchEvidenceScore(match),
  };
}

export function catalogSearchResultDisplay(result: SearchResult): CatalogSearchResultDisplay {
  const targetId = searchResultTargetId(result);
  const fragmentMatches = [
    result.fragmentMatch,
    ...(result.additionalFragmentMatches ?? []),
  ]
    .map(match => catalogFragmentMatchDisplayFromMatch(targetId, match))
    .filter((match): match is CatalogFragmentMatchDisplay => match != null);

  return {
    pathSegments: searchResultPathSegments(result),
    fragmentMatch: fragmentMatches[0] ?? null,
    fragmentMatches,
    overallScoreLabel: formatSearchOverallScore(result.score),
  };
}

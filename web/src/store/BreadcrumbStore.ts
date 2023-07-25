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

import { panic } from "../util/lang";
import { Uid } from "../util/uid";


interface PageBreadcrumb {
  pageId: Uid,
  popupBreadcrumbs: Array<Uid>,
}

let breadcrumbs: Array<PageBreadcrumb> = [];


export const breadcrumbStore = {
  clearBreadcrumbs: (): void => {
    breadcrumbs = [];
  },


  pushTopLevelPageId: (uid: Uid): void => {
    breadcrumbs.push({ pageId: uid, popupBreadcrumbs: [] });
  },

  popTopLevelPageId: (): void => {
    if (breadcrumbs.length <= 1) {
      return;
    }
    breadcrumbs.pop();
  },

  topLevelPageId: (): Uid | null => {
    if (breadcrumbs.length == 0) {
      return null;
    }
    return breadcrumbs[breadcrumbs.length-1].pageId;
  },


  pushPopupId: (uid: Uid): void => {
    if (breadcrumbs.length == 0) {
      panic();
    }
    breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs.push(uid);
  },

  replacePopupId: (uid: Uid): void => {
    if (breadcrumbs.length == 0) {
      panic();
    }
    breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs = [uid];
  },

  popPopupId: (): void => {
    if (breadcrumbs.length == 0) {
      panic();
    }
    if (breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs.length == 0) {
      return;
    }
    breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs.pop();
  },

  popupId: (): Uid | null => {
    if (breadcrumbs.length == 0) {
      panic();
    }
    if (breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs.length == 0) {
      return null;
    }
    const lastBreadcrumbPopups = breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs;
    return lastBreadcrumbPopups[lastBreadcrumbPopups.length-1];
  }
}

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

import { Component, Match, Show, Switch } from "solid-js";
import { useStore } from "../../../store/StoreProvider";
import { InfuIconButton } from "../../library/InfuIconButton";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { ClickState } from "../../../input/state";
import { VesCache } from "../../../layout/ves-cache";
import { asExpressionItem } from "../../../items/expression-item";
import { VeFns } from "../../../layout/visual-element";
import { NoteFns } from "../../../items/note-item";
import { CompositeFlags, NoteFlags } from "../../../items/base/flags-item";
import { asCompositeItem, isComposite } from "../../../items/composite-item";
import { fullArrange } from "../../../layout/arrange";


export const Toolbar_Expression: Component = () => {
  const store = useStore();

  let beforeFormatElement : HTMLDivElement | undefined;
  let qrDiv: HTMLDivElement | undefined;
  let formatDiv: HTMLDivElement | undefined;

  const expressionVisualElementSignal = () => VesCache.get(store.history.getFocusPath())!;
  const expressionVisualElement = () => expressionVisualElementSignal().get();
  const expressionItem = () => asExpressionItem(expressionVisualElement().displayItem);

  const compositeVisualElementMaybe = () => {
    const parentVe = VesCache.get(expressionVisualElement().parentPath!)!.get();
    if (!isComposite(parentVe.displayItem)) { return null; }
    return parentVe;
  };
  const compositeItemMaybe = () => {
    const compositeVeMaybe = compositeVisualElementMaybe();
    if (compositeVeMaybe == null) { return null; }
    return asCompositeItem(compositeVeMaybe.displayItem);
  };

  const isInTable = (): boolean => VeFns.isInTable(expressionVisualElement());

  const handleQr = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.QrLink) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: qrDiv!.getBoundingClientRect().x, y: qrDiv!.getBoundingClientRect().y + 38 }, type: ToolbarPopupType.QrLink });
  }
  const handleQrDown = () => {
    ClickState.setButtonClickBoundsPx(qrDiv!.getBoundingClientRect());
  };

  const handleCopyId = () => {
    navigator.clipboard.writeText(expressionItem().id);
    store.overlay.toolbarTransientMessage.set("expression id → clipboard");
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  const selectNormalText = () => { NoteFns.clearTextStyleFlags(expressionItem()); fullArrange(store); };
  const selectHeading1 = () => { NoteFns.clearTextStyleFlags(expressionItem()); expressionItem().flags |= NoteFlags.Heading1; fullArrange(store); };
  const selectHeading2 = () => { NoteFns.clearTextStyleFlags(expressionItem()); expressionItem().flags |= NoteFlags.Heading2; fullArrange(store); };
  const selectHeading3 = () => { NoteFns.clearTextStyleFlags(expressionItem()); expressionItem().flags |= NoteFlags.Heading3; fullArrange(store); };
  const selectBullet1 = () => { NoteFns.clearTextStyleFlags(expressionItem()); expressionItem().flags |= NoteFlags.Bullet1; fullArrange(store); };
  const selectCode = () => { NoteFns.clearTextStyleFlags(expressionItem()); expressionItem().flags |= NoteFlags.Code; fullArrange(store); };

  const selectAlignLeft = () => { NoteFns.clearAlignmentFlags(expressionItem()); fullArrange(store); };
  const selectAlignCenter = () => { NoteFns.clearAlignmentFlags(expressionItem()); expressionItem().flags |= NoteFlags.AlignCenter; fullArrange(store); };
  const selectAlignRight = () => { NoteFns.clearAlignmentFlags(expressionItem()); expressionItem().flags |= NoteFlags.AlignRight; fullArrange(store); };
  const selectAlignJustify = () => { NoteFns.clearAlignmentFlags(expressionItem()); expressionItem().flags |= NoteFlags.AlignJustify; fullArrange(store); };

  const borderVisible = (): boolean => {
    if (compositeItemMaybe() != null) {
      return (compositeItemMaybe()!.flags & CompositeFlags.HideBorder) ? false : true;
    }
    return (expressionItem().flags & NoteFlags.HideBorder) ? false : true;
  }

  const borderButtonHandler = (): void => {
    if (compositeItemMaybe() != null) {
      if (compositeItemMaybe()!.flags & CompositeFlags.HideBorder) {
        compositeItemMaybe()!.flags &= ~CompositeFlags.HideBorder;
      } else {
        compositeItemMaybe()!.flags |= CompositeFlags.HideBorder;
      }
    } else {
      if (expressionItem().flags & NoteFlags.HideBorder) {
        expressionItem().flags &= ~NoteFlags.HideBorder;
      } else {
        expressionItem().flags |= NoteFlags.HideBorder;
      }
    }
    fullArrange(store);
  };

  // Format
  const formatHandler = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.NoteFormat) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: beforeFormatElement!.getBoundingClientRect().x, y: beforeFormatElement!.getBoundingClientRect().y + 20 }, type: ToolbarPopupType.NoteFormat });
  }
  const handleFormatDown = () => {
    ClickState.setButtonClickBoundsPx(formatDiv!.getBoundingClientRect());
  };

  const renderSingleExpressionToolbox = () =>
    <div class="inline-block">
      <Show when={store.user.getUserMaybe() != null && store.user.getUser().userId == expressionItem().ownerId}>
        <InfuIconButton icon="fa fa-font" highlighted={NoteFns. isStyleNormalText(expressionItem())} clickHandler={selectNormalText} />
        <Show when={!isInTable()}>
          <InfuIconButton icon="bi-type-h1" highlighted={(expressionItem().flags & NoteFlags.Heading1) ? true : false} clickHandler={selectHeading1} />
          <InfuIconButton icon="bi-type-h2" highlighted={(expressionItem().flags & NoteFlags.Heading2) ? true : false} clickHandler={selectHeading2} />
        </Show>
        <InfuIconButton icon="bi-type-h3" highlighted={(expressionItem().flags & NoteFlags.Heading3) ? true : false} clickHandler={selectHeading3} />
        <Show when={!isInTable()}>
          <InfuIconButton icon="fa fa-list" highlighted={(expressionItem().flags & NoteFlags.Bullet1) ? true : false} clickHandler={selectBullet1} />
        </Show>
        <InfuIconButton icon="fa fa-code" highlighted={(expressionItem().flags & NoteFlags.Code) ? true : false} clickHandler={selectCode} />
        <div class="inline-block ml-[20px]"></div>
        <InfuIconButton icon="fa fa-align-left" highlighted={NoteFns.isAlignedLeft(expressionItem())} clickHandler={selectAlignLeft} />
        <InfuIconButton icon="fa fa-align-center" highlighted={(expressionItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
        <InfuIconButton icon="fa fa-align-right" highlighted={(expressionItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
        <InfuIconButton icon="fa fa-align-justify" highlighted={(expressionItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
        <div ref={beforeFormatElement} class="inline-block ml-[12px]"></div>
        <div ref={formatDiv} class="inline-block"
             onMouseDown={handleFormatDown}>
          <InfuIconButton icon={`fa fa-asterisk`} highlighted={false} clickHandler={formatHandler} />
        </div>
        <Show when={!isInTable()}>
          <InfuIconButton icon="fa fa-square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
        </Show>
      </Show>

      {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
      <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

      <div ref={qrDiv} class="inline-block pl-[18px]" onMouseDown={handleQrDown}>
        <InfuIconButton icon="bi-info-circle-fill" highlighted={false} clickHandler={handleQr} />
      </div>
      <div class="inline-block">
        <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleCopyId} />
      </div>

    </div>;

  const renderCompositeToolbox = () =>
    <div class="inline-block">
      <Show when={store.user.getUserMaybe() != null && store.user.getUser().userId == expressionItem().ownerId}>
        <InfuIconButton icon="fa fa-font" highlighted={NoteFns.isStyleNormalText(expressionItem())} clickHandler={selectNormalText} />
        <InfuIconButton icon="bi-type-h1" highlighted={(expressionItem().flags & NoteFlags.Heading1) ? true : false} clickHandler={selectHeading1} />
        <InfuIconButton icon="bi-type-h2" highlighted={(expressionItem().flags & NoteFlags.Heading2) ? true : false} clickHandler={selectHeading2} />
        <InfuIconButton icon="bi-type-h3" highlighted={(expressionItem().flags & NoteFlags.Heading3) ? true : false} clickHandler={selectHeading3} />
        <InfuIconButton icon="fa fa-list" highlighted={(expressionItem().flags & NoteFlags.Bullet1) ? true : false} clickHandler={selectBullet1} />
        <InfuIconButton icon="fa fa-code" highlighted={(expressionItem().flags & NoteFlags.Code) ? true : false} clickHandler={selectCode} />
        <div class="inline-block ml-[20px]"></div>
        <InfuIconButton icon="fa fa-align-left" highlighted={NoteFns.isAlignedLeft(expressionItem())} clickHandler={selectAlignLeft} />
        <InfuIconButton icon="fa fa-align-center" highlighted={(expressionItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
        <InfuIconButton icon="fa fa-align-right" highlighted={(expressionItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
        <InfuIconButton icon="fa fa-align-justify" highlighted={(expressionItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
        <div ref={beforeFormatElement} class="inline-block ml-[12px]"></div>
        <div ref={formatDiv} class="inline-block"
             onMouseDown={handleFormatDown}>
          <InfuIconButton icon={`fa fa-asterisk`} highlighted={false} clickHandler={formatHandler} />
        </div>
        <div class="inline-block">
          <InfuIconButton icon="fa fa-square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
        </div>
      </Show>

      {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
      <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

      <div ref={qrDiv} class="inline-block pl-[18px]" onMouseDown={handleQrDown}>
        <InfuIconButton icon="bi-info-circle-fill" highlighted={false} clickHandler={handleQr} />
      </div>
      <div class="inline-block">
        <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleCopyId} />
      </div>

    </div>;

  return (
    <div id="toolbarItemOptionsDiv"
         class="flex-grow-0" style="flex-order: 0">
      <Switch>
        <Match when={compositeItemMaybe() == null}>{renderSingleExpressionToolbox()}</Match>
        <Match when={compositeItemMaybe() != null}>{renderCompositeToolbox()}</Match>
      </Switch>
    </div>
  );

}

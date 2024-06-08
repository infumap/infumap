

// const keyDown_Backspace = async (store: StoreContextModel, ev: KeyboardEvent): Promise<void> => {
//   if (store.user.getUserMaybe() == null || noteItem(store).ownerId != store.user.getUser().userId) { return; }
//   if (textElement!.selectionStart != textElement!.selectionEnd) { return; }
//   if (textElement!.selectionStart != 0) { return; }

//   const ve = noteVisualElement(store);
//   let parentVe = VesCache.get(ve.parentPath!)!.get();

//   if (isPage(parentVe.displayItem) && (asPageItem(parentVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document)) {
//     // ## document page case

//     const closest = findClosest(VeFns.veToPath(ve), FindDirection.Up, true, false);
//     if (closest == null) { return; }

//     // definitely delete note item.
//     ev.preventDefault();
//     const veid = VeFns.veidFromPath(closest);
//     const nextFocusItem = asTitledItem(itemState.get(veid.itemId)!);
//     nextFocusItem.title = nextFocusItem.title + textElement!.value;

//     store.overlay.setNoteEditOverlayInfo(store.history, null);
//     store.overlay.setNoteEditOverlayInfo(store.history, { itemPath: closest, initialCursorPosition: nextFocusItem.title.length - textElement!.value.length });
//     const canonicalId = VeFns.canonicalItem(ve).id;
//     deleted = true;
//     itemState.delete(canonicalId);
//     await server.deleteItem(canonicalId);
//     fullArrange(store);

//     justCreatedNoteItemMaybe = null;

//   } else {
//     // ## composite case

//     // maybe delete note item.
//     let compositeVe = parentVe;
//     if (!isComposite(compositeVe.displayItem)) { return; }
//     const closest = findClosest(VeFns.veToPath(ve), FindDirection.Up, true, false);
//     if (closest == null) { return; }

//     const veid = VeFns.veidFromPath(closest);
//     const nextFocusItem = asTitledItem(itemState.get(veid.itemId)!);
//     nextFocusItem.title = nextFocusItem.title + textElement!.value;

//     // definitely delete note item.
//     ev.preventDefault();
//     store.overlay.setNoteEditOverlayInfo(store.history, null);
//     store.overlay.setNoteEditOverlayInfo(store.history, { itemPath: closest, initialCursorPosition: nextFocusItem.title.length - textElement!.value.length });
//     const canonicalId = VeFns.canonicalItem(ve).id;
//     deleted = true;
//     itemState.delete(canonicalId);
//     await server.deleteItem(canonicalId);
//     fullArrange(store);

//     justCreatedCompositeItemMaybe = null;
//     justCreatedNoteItemMaybe = null;

//     // maybe delete composite item and move note to parent.
//     compositeVe = VesCache.get(ve.parentPath!)!.get();
//     assert(isComposite(compositeVe.displayItem), "parentVe is not a composite.");
//     const compositeItem = asCompositeItem(compositeVe.displayItem);
//     if (compositeItem.computed_children.length > 1) { return; }

//     // definitely delete composite item and move note to parent.
//     assert(compositeItem.computed_children.length == 1, "composite has other than one child.");
//     const keepNoteId = compositeItem.computed_children[0];
//     const keepNote = itemState.get(keepNoteId)!;
//     const canonicalCompositeItem = VeFns.canonicalItem(compositeVe);
//     const posGr = asPositionalItem(canonicalCompositeItem).spatialPositionGr;
//     const compositePageId = canonicalCompositeItem.parentId;
//     store.overlay.setNoteEditOverlayInfo(store.history, null);
//     setTimeout(() => {
//       itemState.moveToNewParent(keepNote, compositePageId, canonicalCompositeItem.relationshipToParent, canonicalCompositeItem.ordering);
//       asPositionalItem(keepNote).spatialPositionGr = posGr;
//       serverOrRemote.updateItem(keepNote);
//       itemState.delete(compositeVe.displayItem.id);
//       server.deleteItem(compositeVe.displayItem.id);
//       fullArrange(store);
//       store.overlay.setNoteEditOverlayInfo(store.history, null);
//       store.overlay.setNoteEditOverlayInfo(store.history, { itemPath: VeFns.addVeidToPath(VeFns.veidFromId(keepNoteId), compositeVe.parentPath!), initialCursorPosition: nextFocusItem.title.length - textElement!.value.length });
//     }, 0);
//   }
// };


// const keyDown_Enter = async (store: StoreContextModel, ev: KeyboardEvent): Promise<void> => {
//   if (store.user.getUserMaybe() == null || noteItem(store).ownerId != store.user.getUser().userId) { return; }
//   ev.preventDefault();
//   const ve = noteVisualElement(store);
//   const parentVe = VesCache.get(ve.parentPath!)!.get();

//   const beforeText = textElement!.value.substring(0, textElement!.selectionStart);
//   const afterText = textElement!.value.substring(textElement!.selectionEnd);

//   if (ve.flags & VisualElementFlags.InsideTable || noteVisualElement(store).actualLinkItemMaybe != null) {
//     serverOrRemote.updateItem(ve.displayItem);
//     store.overlay.setNoteEditOverlayInfo(store.history, null);
//     fullArrange(store);

//   } else if (isPage(parentVe.displayItem) && asPageItem(parentVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document) { 

//     serverOrRemote.updateItem(ve.displayItem);
//     const ordering = itemState.newOrderingDirectlyAfterChild(parentVe.displayItem.id, VeFns.canonicalItem(ve).id);
//     noteItem(store).title = beforeText;
//     serverOrRemote.updateItem(noteItem(store));
//     const note = NoteFns.create(ve.displayItem.ownerId, parentVe.displayItem.id, RelationshipToParent.Child, "", ordering);
//     note.title = afterText;
//     itemState.add(note);
//     server.addItem(note, null);
//     fullArrange(store);
//     const itemPath = VeFns.addVeidToPath(VeFns.veidFromItems(note, null), ve.parentPath!!);
//     store.overlay.setNoteEditOverlayInfo(store.history, null);
//     store.overlay.setNoteEditOverlayInfo(store.history, { itemPath, initialCursorPosition: CursorPosition.Start });

//   } else if (isComposite(parentVe.displayItem)) {

//   } else {

//   }
// };

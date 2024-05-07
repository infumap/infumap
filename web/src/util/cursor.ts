// implementation as in:
// https://phuoc.ng/collection/html-dom/get-or-set-the-cursor-position-in-a-content-editable-element/

export const setCursorPosition = (el: any, targetPosition: number) => {
  const createRange = (node: any, targetPosition: number) => {
    let range = document.createRange();
    range.selectNode(node);
    range.setStart(node, 0);
    let pos = 0;
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current.nodeType === Node.TEXT_NODE) {
        const len = current.textContent.length;
        if (pos + len >= targetPosition) {
          range.setEnd(current, targetPosition - pos);
          return range;
        }
        pos += len;
      } else if (current.childNodes && current.childNodes.length > 0) {
        for (let i = current.childNodes.length - 1; i >= 0; i--) {
          stack.push(current.childNodes[i]);
        }
      }
    }
    // The target position is greater than the length of the contenteditable element.
    range.setEnd(node, node.childNodes.length);
    return range;
  };

  const range = createRange(el, targetPosition);
  range.setStart(range.endContainer, range.endOffset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
};

export const getCursorPosition = (el: any) => {
  const sel = window.getSelection()!;
  // TODO (LOW): consider sel.rangeCount
  const range = sel.getRangeAt(0);
  const clonedRange = range.cloneRange();
  clonedRange.selectNodeContents(el!);
  clonedRange.setEnd(range.endContainer, range.endOffset);
  const cursorPosition = clonedRange.toString().length;
  return cursorPosition
}

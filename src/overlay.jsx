// Shared fullscreen overlay primitive.
//
// WHY THIS EXISTS
// `position: fixed` is only viewport-fixed relative to its nearest STACKING
// CONTEXT, and this app creates several without meaning to. The chart viewer
// renders inside `.mover-detail-inner`, which is
// `position: sticky` — and a stickily-positioned element ALWAYS creates a
// stacking context, no z-index needed. So the viewer's `z-index: 200` was
// scoped inside that context, which itself paints at level 0 in `.content`,
// while `.topbar` is a sibling context at `z-index: 20`. Result: the Top Movers
// header bar painted straight over the viewer, taking the close button with it.
//
// Portalling into <body> puts every overlay in the root stacking context, where
// its z-index is absolute and no future `sticky`/`transform`/`filter` ancestor
// can trap it again.
//
// Every fullscreen viewer routes through this so they all behave identically:
// covers the whole app, visible × top-right, ESC, click-outside to close.
//
// Identifiers are prefixed `hgo`/`Hg` to stay unique in the shared global scope.

// Only the top-most overlay owns ESC and the backdrop, so nesting one viewer
// inside another closes them one at a time instead of all at once.
const hgoStack = [];
let hgoPrevOverflow = "";

function HgOverlay({ label, onClose, className, children }) {
  // Held in a ref so an inline `onClose={() => ...}` doesn't re-run the effect
  // on every render — that would thrash the stack and the scroll lock.
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useEffect(() => {
    const me = {};
    hgoStack.push(me);
    if (hgoStack.length === 1) {
      hgoPrevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (hgoStack[hgoStack.length - 1] !== me) return;
      // Capture phase + stopPropagation so the modal owns the key and it never
      // reaches the day selector or any other page-level handler underneath.
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const i = hgoStack.indexOf(me);
      if (i >= 0) hgoStack.splice(i, 1);
      if (!hgoStack.length) document.body.style.overflow = hgoPrevOverflow;
    };
  }, []);

  // mousedown rather than click: dragging a selection out of the content and
  // releasing on the backdrop shouldn't count as clicking outside. The target
  // check means only the backdrop itself closes — content children never do.
  const backdrop = (e) => { if (e.target === e.currentTarget) closeRef.current(); };

  return ReactDOM.createPortal(
    <div className={`hgo-overlay ${className || ""}`} onMouseDown={backdrop} role="dialog" aria-modal="true">
      {label ? <div className="hgo-label">{label}</div> : null}
      <button type="button" className="hgo-close" onClick={() => closeRef.current()}
        aria-label="Close" title="Close (Esc)">×</button>
      <div className="hgo-body" onMouseDown={backdrop}>{children}</div>
    </div>,
    document.body,
  );
}

Object.assign(window, { HgOverlay });

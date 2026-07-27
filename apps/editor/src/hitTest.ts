export interface EditableHit {
  sceneId: string;
  elementId: string;
}

/**
 * Walk up from a clicked node to the tagged leaf and its scene.
 *
 * The DOM is the registry (SPEC: direct manipulation). geometry comes from
 * `getBoundingClientRect`, which already accounts for the stage's zoom and
 * punch-in transforms. Nothing needs to be kept in sync.
 */
export function findEditableFrom(node: Element | null): EditableHit | null {
  const el = node?.closest<HTMLElement>("[data-edit-id]");
  if (!el) return null;
  const scene = el.closest<HTMLElement>("[data-edit-scene]");
  if (!scene) return null;
  return {
    sceneId: scene.dataset.editScene!,
    elementId: el.dataset.editId!,
  };
}

/**
 * A logical line can render as MULTIPLE wrapped rows that all share one
 * `data-edit-id` (StrikethroughReveal, FINDINGS: shared-id fragments) — union
 * every match's rect so a nudge moves the whole logical line, not just its
 * first fragment.
 */
export function rectOf(root: HTMLElement, sceneId: string, elementId: string): DOMRect | null {
  const nodes = root.querySelectorAll<HTMLElement>(
    `[data-edit-scene="${sceneId}"] [data-edit-id="${elementId}"]`,
  );
  if (nodes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  nodes.forEach((el) => {
    const r = el.getBoundingClientRect();
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  });
  return new DOMRect(left, top, right - left, bottom - top);
}

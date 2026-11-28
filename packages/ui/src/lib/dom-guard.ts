/**
 * Keep React working when something outside it rewrites the page.
 *
 * Browser page translation (Chrome's "Translate this page") and some
 * extensions replace text nodes with their own elements. React still holds the
 * original nodes, so the next update that inserts an element next to such a
 * text (a spinner appearing in a button, say) or removes one fails with
 * "Failed to execute 'insertBefore' on 'Node'" and the whole page crashes.
 *
 * These guards make the two DOM calls React uses tolerant of that: a node to
 * insert before that has moved is replaced by its ancestor that is still here
 * (or the end of the parent), and removing a node that has already moved is a
 * no-op. Normal calls are passed straight through.
 * See https://github.com/facebook/react/issues/11538.
 */
export function installDomGuard(): void {
  if (typeof Node !== "function" || (Node.prototype as { __prooflixGuard?: boolean }).__prooflixGuard) return
  ;(Node.prototype as { __prooflixGuard?: boolean }).__prooflixGuard = true

  const originalRemoveChild = Node.prototype.removeChild
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) return child // already moved or removed by someone else
    return originalRemoveChild.call(this, child) as T
  }

  const originalInsertBefore = Node.prototype.insertBefore
  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, reference: Node | null): T {
    if (reference && reference.parentNode !== this) {
      // the reference was wrapped (e.g. in a <font>): use the wrapper that is our child
      let ancestor: Node | null = reference.parentNode
      while (ancestor && ancestor.parentNode !== this) ancestor = ancestor.parentNode
      return originalInsertBefore.call(this, node, ancestor) as T // null appends
    }
    return originalInsertBefore.call(this, node, reference) as T
  }
}

import { useLayoutEffect, useState, type RefObject } from "react"

const MD = 768 // Tailwind's md breakpoint: below it, pages scroll as a whole
const BOTTOM_GAP = 24 // matches the main area's md:p-6 bottom padding
const MIN_HEIGHT = 360

/**
 * Height that makes the element end at the bottom of the window, so a
 * panel layout fits the screen and its panels scroll inside instead of the
 * page. Re-measured when the window or anything above the element (a
 * wrapping header, an opened import panel) changes size. Undefined on small
 * screens, where the page keeps scrolling normally.
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>): number | undefined {
  const [height, setHeight] = useState<number>()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      if (window.innerWidth < MD) return setHeight(undefined)
      const top = el.getBoundingClientRect().top + window.scrollY
      setHeight(Math.max(MIN_HEIGHT, Math.floor(window.innerHeight - top - BOTTOM_GAP)))
    }
    measure()
    window.addEventListener("resize", measure)
    // content above the element changing size moves its top edge
    const observer = new ResizeObserver(measure)
    if (el.parentElement) observer.observe(el.parentElement)
    return () => {
      window.removeEventListener("resize", measure)
      observer.disconnect()
    }
  }, [ref])

  return height
}

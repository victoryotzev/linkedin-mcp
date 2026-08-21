import { useEffect, useState } from 'hono/jsx/dom';

/**
 * Layout decisions that CSS cannot make alone.
 *
 * Almost everything responsive in this dashboard is a media query in
 * layout.css, and it should stay that way. This exists for the one case CSS
 * cannot express: below a certain width the detail pane stops being a pane and
 * becomes an overlay, and an overlay owes the user a focus trap, an Escape key
 * and `role="dialog"` — none of which is a style.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof matchMedia !== 'function') return false;
    return matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mql = matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/**
 * The width below which a list and a detail cannot both hold a usable measure.
 *
 * `--pane-list-min` plus `--pane-detail-min` plus the gutter is about 47rem of
 * content; under 1024px, once the rail and the page padding are taken out,
 * there is not that much left. Matches the icon-rail breakpoint in layout.css
 * deliberately: one boundary, not two that nearly agree.
 */
export const SPLIT_COLLAPSE = '(max-width: 1023px)';

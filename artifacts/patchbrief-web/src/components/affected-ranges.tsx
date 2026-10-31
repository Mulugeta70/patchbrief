import { useState } from 'react';
import { LinkedText } from './advisory-evidence';
import { visibleRanges } from '../lib/version-presentation';

export function AffectedRanges({ product, ranges, source }: {
  product: string; ranges: string[]; source: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return <li data-testid="item-affected-version-ranges">
    <strong>{product}:</strong>{' '}
    <LinkedText text={`${visibleRanges(ranges, expanded).join(' OR ')} (${source})`} />
    {ranges.length > 3 && <>{' '}<button type="button" className="nav-link"
      aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      {expanded ? 'Show fewer ranges' : `Show all ${ranges.length} ranges`}
    </button></>}
  </li>;
}

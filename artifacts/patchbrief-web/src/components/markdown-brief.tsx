import { useMemo, type ReactNode } from 'react';
import { LinkedText, ReferenceList } from './advisory-evidence';
import { AffectedRanges } from './affected-ranges';
import { parseAffectedRanges } from '../lib/version-presentation';

export function MarkdownBrief({ content }: { content: string }) {
  const blocks = useMemo(() => {
    const lines = content.split('\n');
    const result: ReactNode[] = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i].trim();
      if (!line) { i++; continue; }
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        const text = heading[2];
        const key = i++;
        if (heading[1].length === 1 && text === 'PatchBrief') continue;
        result.push(heading[1].length === 1 ? <h1 key={key}>{text}</h1>
          : heading[1].length === 2 ? <h2 key={key}>{text}</h2> : <h3 key={key}>{text}</h3>);
        if (text.toLowerCase() === 'references') {
          const references: string[] = [];
          while (i < lines.length && !/^#{1,3}\s/.test(lines[i])) {
            const reference = lines[i++].trim().replace(/^[-*]\s+/, '');
            if (reference) references.push(reference);
          }
          result.push(<ReferenceList key={`refs-${key}`} references={references} />);
        }
        if (text.toLowerCase() === 'affected versions') {
          const versionLines: string[] = [];
          let end = i;
          while (end < lines.length && !/^#{1,3}\s/.test(lines[end])) {
            if (lines[end].trim()) versionLines.push(lines[end]);
            end++;
          }
          const products = versionLines.length ? parseAffectedRanges(versionLines) : null;
          if (products) {
            result.push(<ul key={`ranges-${key}`}>{products.map((product) =>
              <AffectedRanges key={`${product.product}:${product.source}`} {...product} />)}</ul>);
            i = end;
          }
        }
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        const key = i;
        const items: string[] = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) items.push(lines[i++].trim().replace(/^[-*]\s+/, ''));
        result.push(<ul key={key}>{items.map((item, index) => <li key={index}><LinkedText text={item} /></li>)}</ul>);
        continue;
      }
      result.push(line.startsWith('Other CVSS scores:')
        ? <p className="other-cvss" key={i++}><small><LinkedText text={line} /></small></p>
        : <p key={i++}><LinkedText text={line} /></p>);
    }
    return result;
  }, [content]);
  if (!content.trim()) return <div className="empty-state">The final brief will appear here when the run completes.</div>;
  return <div className="brief-content" data-testid="content-final-brief">{blocks}</div>;
}

import './architecture-diagram.css';

type BoxProps = { x: number; y: number; w: number; h: number; title: string; sub?: string; kind?: 'core' | 'ext' };
function Box({ x, y, w, h, title, sub, kind }: BoxProps) {
  return <g>
    <rect className={`pb-arch-box ${kind ?? ''}`} x={x} y={y} width={w} height={h} rx="5" />
    <text className="pb-arch-title" x={x + 14} y={y + (sub ? h / 2 - 3 : h / 2 + 5)}>{title}</text>
    {sub && <text className="pb-arch-sub" x={x + 14} y={y + h / 2 + 15}>{sub}</text>}
  </g>;
}

function Marker({ id }: { id: string }) {
  // Tip of the triangle sits at (8,4); refX=8 puts the tip exactly on the line end.
  return <marker id={id} markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse">
    <path className="pb-arch-head" d="M0,0 L8,4 L0,8 Z" />
  </marker>;
}

export function ArchitectureDiagram() {
  const label = 'Browser calls the API server over REST and SSE. The API server starts a run on the runner, which executes inside the server process. The API server reads run state from Postgres; the runner writes step evidence to Postgres, fetches CVEs from the NVD advisory source, and calls the LLM.';
  return <div className="pb-arch" data-testid="diagram-architecture">
    <svg className="pb-arch-svg desktop" viewBox="0 0 900 310" role="img" aria-label={label}>
      <defs><Marker id="pb-arch-head-d" /></defs>
      <rect className="pb-arch-frame" x="250" y="30" width="440" height="130" rx="6" />
      <text className="pb-arch-frame-label" x="264" y="50">Server process</text>
      <line className="pb-arch-line" x1="170" y1="102" x2="270" y2="102" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="220" y="90" textAnchor="middle">REST / SSE</text>
      <line className="pb-arch-line" x1="420" y1="102" x2="520" y2="102" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="470" y="90" textAnchor="middle">starts run</text>
      <line className="pb-arch-line" x1="670" y1="102" x2="760" y2="102" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="725" y="90" textAnchor="middle">prompts</text>
      <line className="pb-arch-line" x1="345" y1="134" x2="345" y2="230" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="353" y="196">reads state</text>
      <line className="pb-arch-line" x1="540" y1="134" x2="540" y2="230" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="548" y="196">writes</text>
      <line className="pb-arch-line" x1="650" y1="134" x2="650" y2="230" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="658" y="196">fetch CVE</text>
      <Box x={20} y={70} w={150} h={64} title="Browser" sub="Review UI · live trace" />
      <Box x={270} y={70} w={150} h={64} title="API server" sub="Runs · events" kind="core" />
      <Box x={520} y={70} w={150} h={64} title="Runner" sub="Five ordered steps" kind="core" />
      <Box x={760} y={70} w={125} h={64} title="LLM" sub="Extract · wording" kind="ext" />
      <Box x={270} y={230} w={290} h={64} title="Postgres" sub="Runs · steps · attempts · evidence" />
      <Box x={620} y={230} w={170} h={64} title="NVD advisory source" sub="Public CVE data" kind="ext" />
    </svg>
    <svg className="pb-arch-svg mobile" viewBox="0 0 320 420" role="img" aria-label={label}>
      <defs><Marker id="pb-arch-head-m" /></defs>
      <rect className="pb-arch-frame" x="20" y="92" width="280" height="200" rx="6" />
      <text className="pb-arch-frame-label" x="30" y="110">Server process</text>
      <line className="pb-arch-line" x1="160" y1="60" x2="160" y2="120" markerEnd="url(#pb-arch-head-m)" />
      <text className="pb-arch-label" x="168" y="84">REST / SSE</text>
      <line className="pb-arch-line" x1="160" y1="170" x2="160" y2="214" markerEnd="url(#pb-arch-head-m)" />
      <text className="pb-arch-label" x="168" y="197">starts run</text>
      <line className="pb-arch-line" x1="70" y1="264" x2="70" y2="350" markerEnd="url(#pb-arch-head-m)" />
      <text className="pb-arch-label" x="76" y="322">writes</text>
      <line className="pb-arch-line" x1="160" y1="264" x2="160" y2="350" markerEnd="url(#pb-arch-head-m)" />
      <text className="pb-arch-label" x="166" y="322">fetch</text>
      <line className="pb-arch-line" x1="250" y1="264" x2="250" y2="350" markerEnd="url(#pb-arch-head-m)" />
      <text className="pb-arch-label" x="256" y="322">calls</text>
      <Box x={40} y={10} w={240} h={50} title="Browser" sub="Review UI · live trace" />
      <Box x={40} y={120} w={240} h={50} title="API server" sub="Runs · events · reads Postgres" kind="core" />
      <Box x={40} y={214} w={240} h={50} title="Runner" sub="Five ordered steps" kind="core" />
      <Box x={4} y={350} w={100} h={60} title="Postgres" sub="Evidence" />
      <Box x={110} y={350} w={100} h={60} title="NVD" sub="Advisories" kind="ext" />
      <Box x={216} y={350} w={100} h={60} title="LLM" sub="Wording" kind="ext" />
    </svg>
  </div>;
}

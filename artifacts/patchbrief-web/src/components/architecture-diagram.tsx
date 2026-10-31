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

function VerticalArrow({ x, from, to, label }: { x: number; from: number; to: number; label: string }) {
  const middle = (from + to) / 2;
  const width = label.length * 7.5 + 20;
  return <g>
    <line className="pb-arch-line" x1={x} y1={from} x2={x} y2={to} markerEnd="url(#pb-arch-head-m)" />
    <rect className="pb-arch-label-bg" x={x - width / 2} y={middle - 12} width={width} height={24} />
    <text className="pb-arch-label" x={x} y={middle} textAnchor="middle" dominantBaseline="middle">{label}</text>
  </g>;
}

export function ArchitectureDiagram() {
  const label = 'Browser calls the API server over HTTP and receives events. The API server starts a run on the runner, which executes inside the server process. The API server reads run state from Postgres; the runner writes step evidence to Postgres, fetches CVEs from the NVD advisory source, and prompts the optional LLM, which is off without a key.';
  return <div className="pb-arch" data-testid="diagram-architecture">
    <svg className="pb-arch-svg desktop" viewBox="0 0 1100 340" role="img" aria-label={label}>
      <defs><Marker id="pb-arch-head-d" /></defs>
      <rect className="pb-arch-frame" x="314" y="28" width="484" height="140" rx="6" />
      <text className="pb-arch-frame-label" x="328" y="49">Server process</text>
      <line className="pb-arch-line" x1="176" y1="110" x2="326" y2="110" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="251" y="92" textAnchor="middle">HTTP + events</text>
      <line className="pb-arch-line" x1="486" y1="110" x2="626" y2="110" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="556" y="92" textAnchor="middle">starts run</text>
      <line className="pb-arch-line" x1="786" y1="110" x2="906" y2="110" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="846" y="92" textAnchor="middle">prompts</text>
      <line className="pb-arch-line" x1="406" y1="142" x2="406" y2="258" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="418" y="200" dominantBaseline="middle">reads state</text>
      <line className="pb-arch-line" x1="666" y1="142" x2="666" y2="258" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="678" y="200" dominantBaseline="middle">writes</text>
      <line className="pb-arch-line" x1="766" y1="142" x2="766" y2="258" markerEnd="url(#pb-arch-head-d)" />
      <text className="pb-arch-label" x="778" y="200" dominantBaseline="middle">fetch CVE</text>
      <Box x={16} y={78} w={160} h={64} title="Browser" sub="Review UI · live trace" />
      <Box x={326} y={78} w={160} h={64} title="API server" sub="Runs · events" kind="core" />
      <Box x={626} y={78} w={160} h={64} title="Runner" sub="Five ordered steps" kind="core" />
      <Box x={906} y={78} w={180} h={64} title="LLM" sub="optional, off without a key" kind="ext" />
      <Box x={326} y={258} w={360} h={64} title="Postgres" sub="Runs · steps · attempts · evidence" />
      <Box x={746} y={258} w={180} h={64} title="NVD advisory source" sub="Public CVE data" kind="ext" />
    </svg>
    <svg className="pb-arch-svg mobile" viewBox="0 0 344 900" role="img" aria-label={label}>
      <defs><Marker id="pb-arch-head-m" /></defs>
      <rect className="pb-arch-frame" x="4" y="144" width="324" height="260" rx="6" />
      <text className="pb-arch-frame-label" x="64" y="158">Server process</text>
      <VerticalArrow x={170} from={70} to={170} label="HTTP + events" />
      <VerticalArrow x={170} from={230} to={330} label="starts run" />
      <VerticalArrow x={170} from={390} to={490} label="writes" />
      <path className="pb-arch-line" d="M112,230 V280 H12 V520 H50" markerEnd="url(#pb-arch-head-m)" />
      <text className="pb-arch-label" x="62" y="264" textAnchor="middle">reads state</text>
      <path className="pb-arch-line" d="M220,390 V440 H312 V680 H290" markerEnd="url(#pb-arch-head-m)" />
      <text className="pb-arch-label" x="266" y="424" textAnchor="middle">fetch CVE</text>
      <path className="pb-arch-line" d="M290,360 H332 V760 H170 V810" markerEnd="url(#pb-arch-head-m)" />
      <text className="pb-arch-label" x="251" y="744" textAnchor="middle">prompts</text>
      <Box x={50} y={10} w={240} h={60} title="Browser" sub="Review UI · live trace" />
      <Box x={50} y={170} w={240} h={60} title="API server" sub="Runs · events" kind="core" />
      <Box x={50} y={330} w={240} h={60} title="Runner" sub="Five ordered steps" kind="core" />
      <Box x={50} y={490} w={240} h={60} title="Postgres" sub="Runs · steps · evidence" />
      <Box x={50} y={650} w={240} h={60} title="NVD advisory source" sub="Public CVE data" kind="ext" />
      <Box x={50} y={810} w={240} h={76} title="LLM" sub="optional, off without a key" kind="ext" />
    </svg>
  </div>;
}
